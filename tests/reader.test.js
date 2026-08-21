import assert from "node:assert/strict";
import test from "node:test";
import { DFU_STATE, DFU_STATUS_OK } from "../web/dfu.js";
import {
  estimateLastProgrammedByte,
  readVectorTable,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
  SpikeRtReader,
} from "../web/reader.js";

test("reader sets address and uploads sequential blocks", async () => {
  const source = new Uint8Array(SPIKE_RT_REGION_BYTES);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = index & 0xff;
  }

  const blocks = [];
  let offset = 0;
  let setAddressPayload = null;
  const device = {
    transferSize: 4096,
    async ensureIdle() {},
    async download(payload, blockNumber) {
      assert.equal(blockNumber, 0);
      setAddressPayload = new Uint8Array(payload);
      return payload.byteLength;
    },
    async pollUntil() {
      return { state: DFU_STATE.DNLOAD_IDLE, status: DFU_STATUS_OK };
    },
    async abortToIdle() {},
    async upload(length, blockNumber) {
      blocks.push(blockNumber);
      const chunk = source.slice(offset, offset + length);
      offset += length;
      return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    },
  };

  const reader = new SpikeRtReader(device);
  const dump = new Uint8Array(await reader.read());
  assert.deepEqual(dump, source);
  assert.equal(blocks[0], 2);
  assert.equal(blocks.at(-1), 2 + blocks.length - 1);
  assert.equal(setAddressPayload[0], 0x21);
  assert.equal(
    new DataView(setAddressPayload.buffer).getUint32(1, true),
    SPIKE_RT_START_ADDRESS,
  );
});

test("reader rejects a non SPIKE-RT range", async () => {
  const reader = new SpikeRtReader({ transferSize: 2048 });
  await assert.rejects(
    () => reader.read(SPIKE_RT_START_ADDRESS, 1024),
    /SPIKE-RT領域/,
  );
});

test("estimate and vector helpers report useful metadata", () => {
  const bytes = new Uint8Array(64).fill(0xff);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x20030000, true);
  view.setUint32(4, 0x08008101, true);
  bytes[20] = 0x42;

  assert.equal(estimateLastProgrammedByte(bytes.buffer), 21);
  assert.deepEqual(readVectorTable(bytes.buffer), {
    initialStackPointer: 0x20030000,
    resetHandler: 0x08008101,
  });
});
