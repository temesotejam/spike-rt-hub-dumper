import { DFU_STATE, DFU_STATUS_OK } from "./dfu.js";

export const SPIKE_RT_START_ADDRESS = 0x08008000;
export const SPIKE_FLASH_END_ADDRESS = 0x08100000;
export const SPIKE_RT_REGION_BYTES = SPIKE_FLASH_END_ADDRESS - SPIKE_RT_START_ADDRESS;

const DFUSE_SET_ADDRESS = 0x21;
const STM32_INTERNAL_FLASH_MAX_UPLOAD = 2048;
const READ_WINDOW_TRANSFERS = 32;
const READ_WINDOW_ATTEMPTS = 2;

function commandPayload(command, address) {
  const payload = new ArrayBuffer(5);
  const view = new DataView(payload);
  view.setUint8(0, command);
  view.setUint32(1, address, true);
  return payload;
}

function validateRange(startAddress, length) {
  if (!Number.isInteger(startAddress) || !Number.isInteger(length) || length <= 0) {
    throw new Error("読み出し範囲が不正です。");
  }
  const endAddress = startAddress + length;
  if (
    startAddress !== SPIKE_RT_START_ADDRESS ||
    endAddress !== SPIKE_FLASH_END_ADDRESS ||
    length !== SPIKE_RT_REGION_BYTES
  ) {
    throw new Error(
      `このツールはSPIKE-RT領域 0x${SPIKE_RT_START_ADDRESS.toString(16)}–0x${SPIKE_FLASH_END_ADDRESS.toString(16)} の読み出しだけを許可します。`,
    );
  }
}

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function hexAddress(address) {
  return `0x${address.toString(16).padStart(8, "0")}`;
}

export class SpikeRtReader {
  constructor(device, callbacks = {}) {
    this.device = device;
    this.log = callbacks.log ?? (() => {});
    this.onProgress = callbacks.onProgress ?? (() => {});
  }

  async setAddress(address) {
    await this.device.download(commandPayload(DFUSE_SET_ADDRESS, address), 0);
    const status = await this.device.pollUntil(
      (current) => current.state === DFU_STATE.DNLOAD_IDLE,
    );
    if (status.status !== DFU_STATUS_OK || status.state !== DFU_STATE.DNLOAD_IDLE) {
      throw new Error(
        `読み出しアドレス設定に失敗しました (state=${status.state}, status=${status.status})。`,
      );
    }
  }

  async recoverToIdle() {
    try {
      await this.device.abortToIdle();
      return true;
    } catch (error) {
      this.log(`DFU状態の復旧に失敗しました: ${asMessage(error)}`);
      return false;
    }
  }

  async readWindow(output, outputOffset, windowAddress, windowLength, transferSize) {
    for (let attempt = 1; attempt <= READ_WINDOW_ATTEMPTS; attempt += 1) {
      try {
        await this.device.abortToIdle();
        await this.setAddress(windowAddress);
        await this.device.abortToIdle();

        let windowOffset = 0;
        let blockNumber = 2;
        while (windowOffset < windowLength) {
          const requested = Math.min(transferSize, windowLength - windowOffset);
          const absoluteAddress = windowAddress + windowOffset;
          let data;
          try {
            data = await this.device.upload(requested, blockNumber);
          } catch (error) {
            throw new Error(
              `${hexAddress(absoluteAddress)} / block ${blockNumber} のUSB読み出しに失敗しました: ${asMessage(error)}`,
            );
          }

          const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (chunk.byteLength !== requested) {
            throw new Error(
              `${hexAddress(absoluteAddress)} / block ${blockNumber} の読み戻しサイズが一致しません (${chunk.byteLength}/${requested})。`,
            );
          }

          output.set(chunk, outputOffset + windowOffset);
          windowOffset += chunk.byteLength;
          blockNumber += 1;
          this.onProgress(outputOffset + windowOffset, SPIKE_RT_REGION_BYTES);
        }

        await this.device.abortToIdle();
        return;
      } catch (error) {
        const message = asMessage(error);
        this.log(
          `区間 ${hexAddress(windowAddress)}–${hexAddress(windowAddress + windowLength)} の読み出し失敗 (${attempt}/${READ_WINDOW_ATTEMPTS}): ${message}`,
        );
        await this.recoverToIdle();
        if (attempt === READ_WINDOW_ATTEMPTS) {
          throw new Error(
            `区間 ${hexAddress(windowAddress)}–${hexAddress(windowAddress + windowLength)} を読み出せませんでした: ${message}`,
          );
        }
        this.log(`同じ区間をアドレス設定からやり直します。`);
      }
    }
  }

  async read(
    startAddress = SPIKE_RT_START_ADDRESS,
    length = SPIKE_RT_REGION_BYTES,
  ) {
    validateRange(startAddress, length);
    if (!Number.isInteger(this.device.transferSize) || this.device.transferSize <= 0) {
      throw new Error(`DFU転送サイズが不正です: ${this.device.transferSize}`);
    }

    const transferSize = Math.min(
      this.device.transferSize,
      STM32_INTERNAL_FLASH_MAX_UPLOAD,
    );
    const windowBytes = transferSize * READ_WINDOW_TRANSFERS;

    this.log(
      `読み出し範囲: ${hexAddress(startAddress)}–${hexAddress(startAddress + length)} (${length} bytes)`,
    );
    this.log(`DFU読み出し転送サイズ: ${transferSize} bytes`);
    this.log(
      `安定化モード: 最大${windowBytes} bytesごとにSet Address Pointerを再設定し、UPLOAD blockを2から再開します。`,
    );
    this.onProgress(0, length);

    await this.device.ensureIdle();

    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const windowLength = Math.min(windowBytes, length - offset);
      const windowAddress = startAddress + offset;
      this.log(
        `読み出し中: ${hexAddress(windowAddress)}–${hexAddress(windowAddress + windowLength)}`,
      );
      await this.readWindow(
        output,
        offset,
        windowAddress,
        windowLength,
        transferSize,
      );
      offset += windowLength;
    }

    return output.buffer;
  }
}

export function estimateLastProgrammedByte(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 0xff) return index + 1;
  }
  return 0;
}

export function readVectorTable(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 8) {
    return { initialStackPointer: null, resetHandler: null };
  }
  const view = new DataView(arrayBuffer);
  return {
    initialStackPointer: view.getUint32(0, true),
    resetHandler: view.getUint32(4, true),
  };
}
