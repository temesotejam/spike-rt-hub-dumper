import assert from "node:assert/strict";
import test from "node:test";
import { DFU_STATE, DFU_STATUS_OK } from "../web/dfu.js";
import {
  SPIKE_FLASH_BYTES,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
} from "../web/reader.js";
import {
  sectorsForRestore,
  SpikeRtRestorer,
  validateRestoreImage,
} from "../web/restore.js";

function commandAddress(payload) {
  const bytes = new Uint8Array(payload);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
}

function sectorSize(address) {
  if (address < 0x08010000) return 16 * 1024;
  if (address < 0x08020000) return 64 * 1024;
  return 128 * 1024;
}

function makeRestoreDevice() {
  const memory = new Uint8Array(SPIKE_RT_REGION_BYTES).fill(0x00);
  const erased = [];
  let state = DFU_STATE.IDLE;
  let currentAddress = SPIKE_RT_START_ADDRESS;
  let getStateCalls = 0;

  const device = {
    transferSize: 2048,
    async ensureIdle() {
      state = DFU_STATE.IDLE;
    },
    async download(data, blockNumber) {
      const bytes = new Uint8Array(data);
      if (blockNumber === 0 && bytes.byteLength === 5) {
        const command = bytes[0];
        const address = commandAddress(data);
        if (command === 0x21) {
          currentAddress = address;
        } else if (command === 0x41) {
          assert.ok(address >= SPIKE_RT_START_ADDRESS, "must not erase protected prefix");
          erased.push(address);
          const offset = address - SPIKE_RT_START_ADDRESS;
          memory.fill(0xff, offset, Math.min(memory.length, offset + sectorSize(address)));
        } else {
          throw new Error(`unexpected command ${command}`);
        }
        state = DFU_STATE.DNLOAD_IDLE;
        return bytes.byteLength;
      }

      assert.ok(blockNumber >= 2);
      const address = currentAddress + (blockNumber - 2) * bytes.byteLength;
      const offset = address - SPIKE_RT_START_ADDRESS;
      memory.set(bytes, offset);
      state = DFU_STATE.DNLOAD_IDLE;
      return bytes.byteLength;
    },
    async pollUntil() {
      return { state: DFU_STATE.DNLOAD_IDLE, status: DFU_STATUS_OK, pollTimeout: 0 };
    },
    async getStatus() {
      return { state, status: DFU_STATUS_OK, pollTimeout: 0 };
    },
    async abort() {
      state = DFU_STATE.IDLE;
    },
    async clearStatus() {
      state = DFU_STATE.IDLE;
    },
    async getState() {
      getStateCalls += 1;
      throw new Error("GETSTATE must not be used");
    },
    async upload(length, blockNumber) {
      const address = currentAddress + (blockNumber - 2) * length;
      const offset = address - SPIKE_RT_START_ADDRESS;
      const chunk = memory.slice(offset, offset + length);
      state = DFU_STATE.UPLOAD_IDLE;
      return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    },
  };

  return {
    device,
    memory,
    erased,
    getStateCallCount: () => getStateCalls,
  };
}

test("restore sector list starts at 0x08008000 and never touches the protected 32 KiB", () => {
  const sectors = sectorsForRestore();
  assert.equal(sectors[0], 0x08008000);
  assert.equal(sectors.at(-1), 0x080e0000);
  assert.equal(sectors.length, 10);
  assert.ok(sectors.every((address) => address >= 0x08008000));
  assert.ok(!sectors.includes(0x08000000));
  assert.ok(!sectors.includes(0x08004000));
});

test("restore accepts only the exact 992 KiB program backup", () => {
  validateRestoreImage(new ArrayBuffer(SPIKE_RT_REGION_BYTES));
  assert.throws(
    () => validateRestoreImage(new ArrayBuffer(SPIKE_FLASH_BYTES)),
    /992 KiB/,
  );
  assert.throws(
    () => validateRestoreImage(new ArrayBuffer(1024)),
    /992 KiB/,
  );
});

test("restorer erases, writes, and byte-verifies the exact program region", async () => {
  const image = new Uint8Array(SPIKE_RT_REGION_BYTES);
  for (let index = 0; index < image.length; index += 1) {
    image[index] = (index * 37 + 11) & 0xff;
  }

  const { device, memory, erased, getStateCallCount } = makeRestoreDevice();
  const phases = new Set();
  const restorer = new SpikeRtRestorer(device, {
    onProgress(phase) {
      phases.add(phase);
    },
  });

  const readback = new Uint8Array(await restorer.restore(image.buffer));

  assert.deepEqual(memory, image);
  assert.deepEqual(readback, image);
  assert.deepEqual(erased, sectorsForRestore());
  assert.deepEqual(phases, new Set(["erase", "write", "verify"]));
  assert.equal(getStateCallCount(), 0);
});
