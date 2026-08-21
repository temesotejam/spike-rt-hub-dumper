import { DFU_STATE, DFU_STATUS_OK } from "./dfu.js";
import {
  SPIKE_FLASH_END_ADDRESS,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
  SpikeRtReader,
} from "./reader.js";

const DFUSE_SET_ADDRESS = 0x21;
const DFUSE_ERASE_SECTOR = 0x41;
const STM32_INTERNAL_FLASH_MAX_TRANSFER = 2048;
const WRITE_WINDOW_TRANSFERS = 32;

// STM32F413 1 MiB internal flash sector map.
const FLASH_SEGMENTS = Object.freeze([
  { start: 0x08000000, end: 0x08010000, sectorSize: 16 * 1024 },
  { start: 0x08010000, end: 0x08020000, sectorSize: 64 * 1024 },
  { start: 0x08020000, end: 0x08100000, sectorSize: 128 * 1024 },
]);

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function hexAddress(address) {
  return `0x${address.toString(16).padStart(8, "0")}`;
}

function commandPayload(command, address) {
  const payload = new ArrayBuffer(5);
  const view = new DataView(payload);
  view.setUint8(0, command);
  view.setUint32(1, address, true);
  return payload;
}

function segmentFor(address) {
  return FLASH_SEGMENTS.find(
    (segment) => segment.start <= address && address < segment.end,
  );
}

export function validateRestoreImage(firmware) {
  if (!(firmware instanceof ArrayBuffer)) {
    throw new TypeError("復元イメージはArrayBufferで指定してください。");
  }
  if (firmware.byteLength !== SPIKE_RT_REGION_BYTES) {
    throw new Error(
      `復元には0x08008000–0x08100000の完全な992 KiBバックアップ (${SPIKE_RT_REGION_BYTES} bytes) が必要です。選択ファイルは${firmware.byteLength} bytesです。`,
    );
  }
}

export function sectorsForRestore() {
  const sectors = [];
  let address = SPIKE_RT_START_ADDRESS;
  while (address < SPIKE_FLASH_END_ADDRESS) {
    const segment = segmentFor(address);
    if (!segment) {
      throw new Error(`フラッシュマップ外です: ${hexAddress(address)}`);
    }
    const index = Math.floor((address - segment.start) / segment.sectorSize);
    const sectorStart = segment.start + index * segment.sectorSize;
    if (sectorStart < SPIKE_RT_START_ADDRESS) {
      throw new Error(
        `安全境界より前のセクタを消去しようとしました: ${hexAddress(sectorStart)}`,
      );
    }
    if (!sectors.includes(sectorStart)) sectors.push(sectorStart);
    address = sectorStart + segment.sectorSize;
  }
  return sectors;
}

export class SpikeRtRestorer {
  constructor(device, callbacks = {}) {
    this.device = device;
    this.log = callbacks.log ?? (() => {});
    this.onProgress = callbacks.onProgress ?? (() => {});
  }

  async runCommand(command, address, name) {
    await this.device.ensureIdle();
    try {
      const written = await this.device.download(commandPayload(command, address), 0);
      if (written !== 5) {
        throw new Error(`USB転送サイズが一致しません (${written}/5)`);
      }
      const status = await this.device.pollUntil(
        (current) => current.state === DFU_STATE.DNLOAD_IDLE,
      );
      if (status.status !== DFU_STATUS_OK || status.state !== DFU_STATE.DNLOAD_IDLE) {
        throw new Error(`state=${status.state}, status=${status.status}`);
      }
    } catch (error) {
      throw new Error(`${name} ${hexAddress(address)} に失敗しました: ${asMessage(error)}`);
    }
  }

  setAddress(address) {
    return this.runCommand(DFUSE_SET_ADDRESS, address, "Set Address Pointer");
  }

  eraseSector(address) {
    return this.runCommand(DFUSE_ERASE_SECTOR, address, "セクタ消去");
  }

  async erase() {
    const sectors = sectorsForRestore();
    this.log(
      `復元用消去: ${sectors.length}セクタ。${hexAddress(SPIKE_RT_START_ADDRESS)}より前は消去しません。`,
    );
    this.onProgress("erase", 0, sectors.length);
    for (let index = 0; index < sectors.length; index += 1) {
      this.log(`消去中: ${hexAddress(sectors[index])}`);
      await this.eraseSector(sectors[index]);
      this.onProgress("erase", index + 1, sectors.length);
    }
    await this.device.ensureIdle();
  }

  async write(firmware) {
    validateRestoreImage(firmware);
    const transferSize = Math.min(
      this.device.transferSize,
      STM32_INTERNAL_FLASH_MAX_TRANSFER,
    );
    if (!Number.isInteger(transferSize) || transferSize <= 0) {
      throw new Error(`DFU転送サイズが不正です: ${this.device.transferSize}`);
    }
    const windowBytes = transferSize * WRITE_WINDOW_TRANSFERS;
    this.log(
      `書き戻し: ${transferSize} bytes/transfer、最大${windowBytes} bytesごとにアドレスを再設定します。`,
    );
    this.onProgress("write", 0, firmware.byteLength);

    let offset = 0;
    while (offset < firmware.byteLength) {
      const windowLength = Math.min(windowBytes, firmware.byteLength - offset);
      const windowAddress = SPIKE_RT_START_ADDRESS + offset;
      await this.setAddress(windowAddress);

      let windowOffset = 0;
      let blockNumber = 2;
      while (windowOffset < windowLength) {
        const length = Math.min(transferSize, windowLength - windowOffset);
        const absoluteAddress = windowAddress + windowOffset;
        const chunk = firmware.slice(offset + windowOffset, offset + windowOffset + length);
        try {
          const written = await this.device.download(chunk, blockNumber);
          const status = await this.device.pollUntil(
            (current) => current.state === DFU_STATE.DNLOAD_IDLE,
          );
          if (status.status !== DFU_STATUS_OK || status.state !== DFU_STATE.DNLOAD_IDLE) {
            throw new Error(`state=${status.state}, status=${status.status}`);
          }
          if (written !== length) {
            throw new Error(`USB転送サイズが一致しません (${written}/${length})`);
          }
        } catch (error) {
          throw new Error(
            `${hexAddress(absoluteAddress)} / block ${blockNumber} の書き込みに失敗しました: ${asMessage(error)}`,
          );
        }
        windowOffset += length;
        blockNumber += 1;
        this.onProgress("write", offset + windowOffset, firmware.byteLength);
      }

      await this.device.ensureIdle();
      offset += windowLength;
    }
  }

  async verify(firmware) {
    validateRestoreImage(firmware);
    this.log("992 KiB全域を再読み出しして1 byteずつ検証します。");
    const reader = new SpikeRtReader(this.device, {
      log: (message) => this.log(`検証: ${message}`),
      onProgress: (done, total) => this.onProgress("verify", done, total),
    });
    const readback = await reader.read(SPIKE_RT_START_ADDRESS, SPIKE_RT_REGION_BYTES);
    const expected = new Uint8Array(firmware);
    const actual = new Uint8Array(readback);
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) {
        throw new Error(
          `読み戻し検証不一致: ${hexAddress(SPIKE_RT_START_ADDRESS + index)} expected=0x${expected[index].toString(16).padStart(2, "0")} actual=0x${actual[index].toString(16).padStart(2, "0")}`,
        );
      }
    }
    return readback;
  }

  async restore(firmware) {
    validateRestoreImage(firmware);
    this.log("復元を開始します。書き込み対象は0x08008000–0x08100000だけです。");
    this.log("0x08000000–0x08008000の先頭32 KiBには一切書き込みません。");
    await this.device.ensureIdle();
    await this.erase();
    await this.write(firmware);
    const readback = await this.verify(firmware);
    await this.device.ensureIdle();
    this.log("全992 KiBのbyte-for-byte検証に成功しました。");
    return readback;
  }
}
