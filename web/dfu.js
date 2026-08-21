export const DFU_REQUEST = Object.freeze({
  DETACH: 0x00,
  DNLOAD: 0x01,
  UPLOAD: 0x02,
  GETSTATUS: 0x03,
  CLRSTATUS: 0x04,
  GETSTATE: 0x05,
  ABORT: 0x06,
});

export const DFU_STATE = Object.freeze({
  APP_IDLE: 0,
  APP_DETACH: 1,
  IDLE: 2,
  DNLOAD_SYNC: 3,
  DNBUSY: 4,
  DNLOAD_IDLE: 5,
  MANIFEST_SYNC: 6,
  MANIFEST: 7,
  MANIFEST_WAIT_RESET: 8,
  UPLOAD_IDLE: 9,
  ERROR: 10,
});

export const DFU_STATUS_OK = 0x00;
export const SPIKE_DFU_VENDOR_ID = 0x0694;
export const SPIKE_DFU_PRODUCT_ID = 0x0008;
const DEFAULT_TRANSFER_SIZE = 2048;

export function isWebUsbAvailable() {
  return Boolean(globalThis.isSecureContext && globalThis.navigator?.usb);
}

function asMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findDfuInterfaces(device) {
  const matches = [];
  device.configurations.forEach((configuration, configurationIndex) => {
    configuration.interfaces.forEach((usbInterface) => {
      usbInterface.alternates.forEach((alternate) => {
        if (
          alternate.interfaceClass === 0xfe &&
          alternate.interfaceSubclass === 0x01 &&
          (alternate.interfaceProtocol === 0x01 || alternate.interfaceProtocol === 0x02)
        ) {
          matches.push({
            configurationIndex,
            configurationValue: configuration.configurationValue,
            interfaceNumber: usbInterface.interfaceNumber,
            alternateSetting: alternate.alternateSetting,
            protocol: alternate.interfaceProtocol,
            interfaceName: alternate.interfaceName ?? "",
          });
        }
      });
    });
  });
  return matches;
}

export class DfuDevice {
  constructor(usbDevice, settings, callbacks = {}) {
    this.usbDevice = usbDevice;
    this.settings = settings;
    this.transferSize = DEFAULT_TRANSFER_SIZE;
    this.attributes = 0;
    this.log = callbacks.log ?? (() => {});
  }

  get label() {
    return this.usbDevice.productName || "LEGO SPIKE Prime Hub";
  }

  async open() {
    await this.usbDevice.open();
    if (
      !this.usbDevice.configuration ||
      this.usbDevice.configuration.configurationValue !== this.settings.configurationValue
    ) {
      await this.usbDevice.selectConfiguration(this.settings.configurationValue);
    }

    const usbInterface = this.usbDevice.configuration.interfaces.find(
      (item) => item.interfaceNumber === this.settings.interfaceNumber,
    );
    if (!usbInterface) {
      throw new Error("DFUインターフェースが見つかりません。");
    }

    if (!usbInterface.claimed) {
      await this.usbDevice.claimInterface(this.settings.interfaceNumber);
    }

    const currentAlternate = usbInterface.alternate?.alternateSetting;
    if (currentAlternate !== this.settings.alternateSetting) {
      await this.usbDevice.selectAlternateInterface(
        this.settings.interfaceNumber,
        this.settings.alternateSetting,
      );
    }

    try {
      const descriptor = await this.readFunctionalDescriptor();
      if (descriptor?.transferSize >= 64 && descriptor.transferSize <= 65535) {
        this.transferSize = descriptor.transferSize;
      }
      this.attributes = descriptor?.attributes ?? 0;
    } catch (error) {
      this.log(
        `DFU機能記述子を取得できないため、転送サイズ${DEFAULT_TRANSFER_SIZE} bytesを使用します: ${asMessage(error)}`,
      );
    }

    await this.ensureIdle();
  }

  async close() {
    if (!this.usbDevice.opened) return;
    try {
      const usbInterface = this.usbDevice.configuration?.interfaces.find(
        (item) => item.interfaceNumber === this.settings.interfaceNumber,
      );
      if (usbInterface?.claimed) {
        await this.usbDevice.releaseInterface(this.settings.interfaceNumber);
      }
    } catch (error) {
      this.log(`インターフェース解放時の警告: ${asMessage(error)}`);
    }
    try {
      await this.usbDevice.close();
    } catch (error) {
      this.log(`USB切断時の警告: ${asMessage(error)}`);
    }
  }

  async readFunctionalDescriptor() {
    const configurationIndex = this.settings.configurationIndex;
    const header = await this.usbDevice.controlTransferIn(
      {
        requestType: "standard",
        recipient: "device",
        request: 0x06,
        value: 0x0200 | configurationIndex,
        index: 0,
      },
      9,
    );
    if (header.status !== "ok" || !header.data || header.data.byteLength < 4) {
      throw new Error(`設定記述子の取得に失敗しました: ${header.status}`);
    }

    const totalLength = header.data.getUint16(2, true);
    const response = await this.usbDevice.controlTransferIn(
      {
        requestType: "standard",
        recipient: "device",
        request: 0x06,
        value: 0x0200 | configurationIndex,
        index: 0,
      },
      totalLength,
    );
    if (response.status !== "ok" || !response.data) {
      throw new Error(`DFU機能記述子の取得に失敗しました: ${response.status}`);
    }

    const view = response.data;
    let offset = 0;
    let matchingInterface = false;
    while (offset + 2 <= view.byteLength) {
      const length = view.getUint8(offset);
      const type = view.getUint8(offset + 1);
      if (length < 2 || offset + length > view.byteLength) break;

      if (type === 0x04 && length >= 9) {
        matchingInterface =
          view.getUint8(offset + 2) === this.settings.interfaceNumber &&
          view.getUint8(offset + 3) === this.settings.alternateSetting;
      } else if (matchingInterface && type === 0x21 && length >= 9) {
        return {
          attributes: view.getUint8(offset + 2),
          detachTimeout: view.getUint16(offset + 3, true),
          transferSize: view.getUint16(offset + 5, true),
          version: view.getUint16(offset + 7, true),
        };
      }
      offset += length;
    }
    throw new Error("対象インターフェースのDFU機能記述子がありません。");
  }

  async requestOut(request, data = new ArrayBuffer(0), value = 0) {
    try {
      const result = await this.usbDevice.controlTransferOut(
        {
          requestType: "class",
          recipient: "interface",
          request,
          value,
          index: this.settings.interfaceNumber,
        },
        data,
      );
      if (result.status !== "ok") throw new Error(result.status);
      return result.bytesWritten ?? 0;
    } catch (error) {
      throw new Error(`USB送信に失敗しました: ${asMessage(error)}`);
    }
  }

  async requestIn(request, length, value = 0) {
    try {
      const result = await this.usbDevice.controlTransferIn(
        {
          requestType: "class",
          recipient: "interface",
          request,
          value,
          index: this.settings.interfaceNumber,
        },
        length,
      );
      if (result.status !== "ok" || !result.data) throw new Error(result.status);
      return result.data;
    } catch (error) {
      throw new Error(`USB受信に失敗しました: ${asMessage(error)}`);
    }
  }

  download(data, blockNumber) {
    return this.requestOut(DFU_REQUEST.DNLOAD, data, blockNumber);
  }

  upload(length, blockNumber) {
    return this.requestIn(DFU_REQUEST.UPLOAD, length, blockNumber);
  }

  async getStatus() {
    const data = await this.requestIn(DFU_REQUEST.GETSTATUS, 6);
    return {
      status: data.getUint8(0),
      pollTimeout:
        data.getUint8(1) |
        (data.getUint8(2) << 8) |
        (data.getUint8(3) << 16),
      state: data.getUint8(4),
      stringIndex: data.getUint8(5),
    };
  }

  async getState() {
    const data = await this.requestIn(DFU_REQUEST.GETSTATE, 1);
    return data.getUint8(0);
  }

  clearStatus() {
    return this.requestOut(DFU_REQUEST.CLRSTATUS);
  }

  abort() {
    return this.requestOut(DFU_REQUEST.ABORT);
  }

  async pollUntil(predicate, timeoutMilliseconds = 60000) {
    const deadline = performance.now() + timeoutMilliseconds;
    let status = await this.getStatus();
    while (!predicate(status) && status.state !== DFU_STATE.ERROR) {
      if (performance.now() > deadline) {
        throw new Error("DFU状態遷移がタイムアウトしました。");
      }
      await sleep(Math.max(1, status.pollTimeout));
      status = await this.getStatus();
    }
    return status;
  }

  async ensureIdle() {
    let status = await this.getStatus();
    if (
      status.state === DFU_STATE.DNLOAD_SYNC ||
      status.state === DFU_STATE.DNBUSY ||
      status.state === DFU_STATE.MANIFEST_SYNC ||
      status.state === DFU_STATE.MANIFEST
    ) {
      status = await this.pollUntil(
        (current) =>
          current.state === DFU_STATE.IDLE ||
          current.state === DFU_STATE.DNLOAD_IDLE ||
          current.state === DFU_STATE.UPLOAD_IDLE ||
          current.state === DFU_STATE.MANIFEST_WAIT_RESET,
      );
    }

    if (status.state === DFU_STATE.ERROR) {
      await this.clearStatus();
      status = await this.getStatus();
    }

    if (status.state === DFU_STATE.DNLOAD_IDLE || status.state === DFU_STATE.UPLOAD_IDLE) {
      await this.abort();
      status = await this.getStatus();
    }

    if (status.state !== DFU_STATE.IDLE || status.status !== DFU_STATUS_OK) {
      throw new Error(
        `HubがDFU待機状態ではありません (state=${status.state}, status=${status.status})。`,
      );
    }
  }

  async abortToIdle() {
    let state = await this.getState();
    if (state === DFU_STATE.ERROR) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state !== DFU_STATE.IDLE) {
      await this.abort();
      state = await this.getState();
    }
    if (state !== DFU_STATE.IDLE) {
      throw new Error(`DFU待機状態へ戻せませんでした (state=${state})。`);
    }
  }
}

export async function connectSpikeDfu(callbacks = {}) {
  if (!isWebUsbAvailable()) {
    throw new Error("このブラウザではWebUSBを利用できません。HTTPS上のChromeまたはEdgeを使用してください。");
  }

  const usbDevice = await navigator.usb.requestDevice({
    filters: [{ vendorId: SPIKE_DFU_VENDOR_ID, productId: SPIKE_DFU_PRODUCT_ID }],
  });

  if (
    usbDevice.vendorId !== SPIKE_DFU_VENDOR_ID ||
    usbDevice.productId !== SPIKE_DFU_PRODUCT_ID
  ) {
    throw new Error("SPIKE Prime HubのDFUデバイスではありません。");
  }

  const matches = findDfuInterfaces(usbDevice);
  const settings = matches.find((candidate) => candidate.protocol === 0x02) ?? matches[0];
  if (!settings) {
    throw new Error("USB DFUインターフェースが見つかりません。HubをDFUモードで接続してください。");
  }

  const device = new DfuDevice(usbDevice, settings, callbacks);
  try {
    await device.open();
    return device;
  } catch (error) {
    await device.close();
    throw error;
  }
}
