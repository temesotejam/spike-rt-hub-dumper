import assert from "node:assert/strict";
import test from "node:test";
import { DFU_STATE, DFU_STATUS_OK } from "../web/dfu.js";
import {
  estimateLastProgrammedByte,
  readVectorTable,
  SPIKE_FLASH_BYTES,
  SPIKE_FLASH_START_ADDRESS,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
  SpikeRtReader,
} from "../web/reader.js";

function makeSource(length) {
  const source = new Uint8Array(length);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = index & 0xff;
  }
  return source;
}

function addressFromPayload(payload) {
  const bytes = new Uint8Array(payload);
  assert.equal(bytes[0], 0x21);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
}

function addStatusMachine(device, initialState = DFU_STATE.IDLE) {
  let state = initialState;
  let getStateCalls = 0;
  return Object.assign(device, {
    async ensureIdle() {
      state = DFU_STATE.IDLE;
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
      throw new Error("GETSTATE must not be used by the reader");
    },
    setDfuState(nextState) {
      state = nextState;
    },
    getStateCallCount() {
      return getStateCalls;
    },
  });
}

function makeReadDevice(source, startAddress, transferSize = 2048) {
  let currentAddress = startAddress;
  const setAddresses = [];
  const blocks = [];
  const device = addStatusMachine({
    transferSize,
    async download(payload, blockNumber) {
      assert.equal(blockNumber, 0);
      currentAddress = addressFromPayload(payload);
      setAddresses.push(currentAddress);
      this.setDfuState(DFU_STATE.DNLOAD_IDLE);
      return payload.byteLength;
    },
    async pollUntil() {
      return { state: DFU_STATE.DNLOAD_IDLE, status: DFU_STATUS_OK };
    },
    async upload(length, blockNumber) {
      blocks.push(blockNumber);
      this.setDfuState(DFU_STATE.UPLOAD_IDLE);
      const absoluteAddress = currentAddress + (blockNumber - 2) * length;
      const sourceOffset = absoluteAddress - startAddress;
      const chunk = source.slice(sourceOffset, sourceOffset + length);
      return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    },
  });
  return { device, setAddresses, blocks };
}

test("reader resets the DfuSe address and block number in bounded windows", async () => {
  const source = makeSource(SPIKE_RT_REGION_BYTES);
  const { device, setAddresses, blocks } = makeReadDevice(
    source,
    SPIKE_RT_START_ADDRESS,
    4096,
  );

  const reader = new SpikeRtReader(device);
  const dump = new Uint8Array(await reader.read());

  assert.deepEqual(dump, source);
  assert.equal(device.getStateCallCount(), 0);
  assert.equal(setAddresses[0], SPIKE_RT_START_ADDRESS);
  assert.ok(setAddresses.length > 1);
  assert.equal(blocks.filter((block) => block === 2).length, setAddresses.length);
  assert.ok(Math.max(...blocks) <= 33);
  for (let index = 1; index < setAddresses.length; index += 1) {
    assert.equal(setAddresses[index] - setAddresses[index - 1], 64 * 1024);
  }
});

test("reader supports an exact 1 MiB full-flash read without arbitrary ranges", async () => {
  const source = makeSource(SPIKE_FLASH_BYTES);
  const { device, setAddresses } = makeReadDevice(source, SPIKE_FLASH_START_ADDRESS);
  const progress = [];
  const reader = new SpikeRtReader(device, {
    onProgress(done, total) {
      progress.push([done, total]);
    },
  });

  const dump = new Uint8Array(
    await reader.read(SPIKE_FLASH_START_ADDRESS, SPIKE_FLASH_BYTES),
  );

  assert.deepEqual(dump, source);
  assert.equal(setAddresses[0], SPIKE_FLASH_START_ADDRESS);
  assert.equal(progress.at(-1)[0], SPIKE_FLASH_BYTES);
  assert.equal(progress.at(-1)[1], SPIKE_FLASH_BYTES);
});

test("reader retries one failed window from a fresh address pointer", async () => {
  const source = makeSource(SPIKE_RT_REGION_BYTES);
  const secondWindow = SPIKE_RT_START_ADDRESS + 64 * 1024;
  const setAddresses = [];
  let currentAddress = SPIKE_RT_START_ADDRESS;
  let injectedFailure = false;

  const device = addStatusMachine({
    transferSize: 2048,
    async download(payload) {
      currentAddress = addressFromPayload(payload);
      setAddresses.push(currentAddress);
      this.setDfuState(DFU_STATE.DNLOAD_IDLE);
      return payload.byteLength;
    },
    async pollUntil() {
      return { state: DFU_STATE.DNLOAD_IDLE, status: DFU_STATUS_OK };
    },
    async upload(length, blockNumber) {
      this.setDfuState(DFU_STATE.UPLOAD_IDLE);
      if (!injectedFailure && currentAddress === secondWindow && blockNumber === 5) {
        injectedFailure = true;
        throw new Error("simulated USB stall");
      }
      const absoluteAddress = currentAddress + (blockNumber - 2) * length;
      const sourceOffset = absoluteAddress - SPIKE_RT_START_ADDRESS;
      const chunk = source.slice(sourceOffset, sourceOffset + length);
      return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    },
  });

  const reader = new SpikeRtReader(device);
  const dump = new Uint8Array(await reader.read());

  assert.deepEqual(dump, source);
  assert.equal(device.getStateCallCount(), 0);
  assert.equal(injectedFailure, true);
  assert.equal(setAddresses.filter((address) => address === secondWindow).length, 2);
});

test("reader rejects arbitrary subranges", async () => {
  const reader = new SpikeRtReader({ transferSize: 2048 });
  await assert.rejects(
    () => reader.read(SPIKE_RT_START_ADDRESS, 1024),
    /固定読み出し/,
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
