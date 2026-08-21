import { DFU_STATE, DFU_STATUS_OK } from "./dfu.js";

export const SPIKE_RT_START_ADDRESS = 0x08008000;
export const SPIKE_FLASH_END_ADDRESS = 0x08100000;
export const SPIKE_RT_REGION_BYTES = SPIKE_FLASH_END_ADDRESS - SPIKE_RT_START_ADDRESS;

const DFUSE_SET_ADDRESS = 0x21;
const STM32_INTERNAL_FLASH_MAX_UPLOAD = 2048;

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

    this.log(
      `読み出し範囲: 0x${startAddress.toString(16)}–0x${(startAddress + length).toString(16)} (${length} bytes)`,
    );
    this.log(`DFU読み出し転送サイズ: ${transferSize} bytes`);
    this.onProgress(0, length);

    await this.device.ensureIdle();
    await this.setAddress(startAddress);
    await this.device.abortToIdle();

    const output = new Uint8Array(length);
    let offset = 0;
    let blockNumber = 2;

    try {
      while (offset < length) {
        const requested = Math.min(transferSize, length - offset);
        const data = await this.device.upload(requested, blockNumber);
        const chunk = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (chunk.byteLength !== requested) {
          throw new Error(
            `読み戻しサイズが一致しません (block=${blockNumber}, ${chunk.byteLength}/${requested})。`,
          );
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
        blockNumber += 1;
        this.onProgress(offset, length);
      }
    } finally {
      await this.device.abortToIdle();
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
