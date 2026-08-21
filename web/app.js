import {
  connectSpikeDfu,
  isWebUsbAvailable,
  SPIKE_DFU_PRODUCT_ID,
  SPIKE_DFU_VENDOR_ID,
} from "./dfu.js";
import {
  estimateLastProgrammedByte,
  readVectorTable,
  SPIKE_FLASH_END_ADDRESS,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
  SpikeRtReader,
} from "./reader.js";

const DEFAULT_CATALOG_URL =
  "https://temesotejam.github.io/spike-rt-web-project/firmware/catalog.json";

const elements = {
  browserStatus: document.querySelector("#browser-status"),
  deviceStatus: document.querySelector("#device-status"),
  transferSize: document.querySelector("#transfer-size"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  read: document.querySelector("#read"),
  downloadBin: document.querySelector("#download-bin"),
  downloadMetadata: document.querySelector("#download-metadata"),
  progress: document.querySelector("#progress"),
  progressLabel: document.querySelector("#progress-label"),
  dumpStatus: document.querySelector("#dump-status"),
  dumpSize: document.querySelector("#dump-size"),
  dumpSha: document.querySelector("#dump-sha"),
  programmedBytes: document.querySelector("#programmed-bytes"),
  stackPointer: document.querySelector("#stack-pointer"),
  resetHandler: document.querySelector("#reset-handler"),
  matchStatus: document.querySelector("#match-status"),
  matchDetails: document.querySelector("#match-details"),
  catalogUrl: document.querySelector("#catalog-url"),
  retryMatch: document.querySelector("#retry-match"),
  log: document.querySelector("#log"),
};

let dfuDevice = null;
let dump = null;
let dumpMetadata = null;
let busy = false;

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString("ja-JP");
  elements.log.textContent += `\n[${timestamp}] ${message}`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function formatBytes(bytes) {
  return `${new Intl.NumberFormat("ja-JP").format(bytes)} bytes`;
}

function hex(value, width = 8) {
  if (!Number.isInteger(value)) return "—";
  return `0x${value.toString(16).padStart(width, "0")}`;
}

async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function setBusy(value) {
  busy = value;
  updateControls();
}

function updateControls() {
  const webUsbReady = isWebUsbAvailable();
  elements.connect.disabled = busy || !webUsbReady || Boolean(dfuDevice);
  elements.disconnect.disabled = busy || !dfuDevice;
  elements.read.disabled = busy || !dfuDevice;
  elements.downloadBin.disabled = busy || !dump;
  elements.downloadMetadata.disabled = busy || !dumpMetadata;
  elements.retryMatch.disabled = busy || !dump;
  elements.catalogUrl.disabled = busy;
}

function resetDumpResults(status = "未読み出し") {
  dump = null;
  dumpMetadata = null;
  elements.dumpStatus.textContent = status;
  elements.dumpStatus.className = "";
  elements.dumpSize.textContent = "—";
  elements.dumpSha.textContent = "—";
  elements.programmedBytes.textContent = "—";
  elements.stackPointer.textContent = "—";
  elements.resetHandler.textContent = "—";
  elements.matchStatus.textContent = "未照合";
  elements.matchStatus.className = "";
  elements.matchDetails.textContent = "—";
  elements.progress.value = 0;
  elements.progressLabel.textContent = "待機中";
  updateControls();
}

function clearConnectedDevice(message = "未接続") {
  dfuDevice = null;
  elements.deviceStatus.textContent = message;
  elements.deviceStatus.className = "";
  elements.transferSize.textContent = "—";
  updateControls();
}

async function connectHub() {
  setBusy(true);
  elements.deviceStatus.textContent = "接続中";
  elements.deviceStatus.className = "";
  try {
    dfuDevice = await connectSpikeDfu({ log: appendLog });
    elements.deviceStatus.textContent = `${dfuDevice.label} 接続済み`;
    elements.deviceStatus.className = "status-good";
    elements.transferSize.textContent = formatBytes(dfuDevice.transferSize);
    appendLog(
      `接続成功: VID=${hex(SPIKE_DFU_VENDOR_ID, 4)}, PID=${hex(SPIKE_DFU_PRODUCT_ID, 4)}, transfer=${dfuDevice.transferSize}`,
    );
  } catch (error) {
    clearConnectedDevice("接続失敗");
    elements.deviceStatus.className = "status-error";
    appendLog(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
}

async function disconnectHub() {
  if (!dfuDevice) return;
  setBusy(true);
  const current = dfuDevice;
  try {
    await current.close();
    appendLog("Hubとの接続を解除しました。");
  } finally {
    clearConnectedDevice();
    setBusy(false);
  }
}

function setProgress(done, total) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const percent = ratio * 100;
  elements.progress.value = percent;
  elements.progressLabel.textContent = `読み出し中: ${Math.round(percent)}% (${formatBytes(done)} / ${formatBytes(total)})`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function dumpFilename() {
  const compact = new Date().toISOString().replace(/[:.]/g, "-");
  return `spike-rt-${hex(SPIKE_RT_START_ADDRESS).slice(2)}-${compact}.bin`;
}

async function matchKnownFirmware() {
  if (!dump) return [];
  const catalogUrl = elements.catalogUrl.value.trim();
  if (!catalogUrl) {
    elements.matchStatus.textContent = "照合先なし";
    elements.matchDetails.textContent = "catalog.json URLが空です。";
    return [];
  }

  elements.matchStatus.textContent = "照合中";
  elements.matchStatus.className = "";
  elements.matchDetails.textContent = "既知ファームウェアのSHA-256と比較しています。";

  try {
    const response = await fetch(catalogUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`catalog.jsonの取得に失敗しました (${response.status})。`);
    }
    const catalog = await response.json();
    if (!Array.isArray(catalog.apps)) {
      throw new Error("catalog.jsonにapps配列がありません。");
    }

    const hashBySize = new Map();
    const matches = [];
    for (const app of catalog.apps) {
      const size = Number(app.size);
      const expectedSha = String(app.sha256 ?? "").toLowerCase();
      if (!Number.isInteger(size) || size <= 0 || size > dump.byteLength || !expectedSha) {
        continue;
      }
      let actualSha = hashBySize.get(size);
      if (!actualSha) {
        actualSha = await sha256Hex(dump.slice(0, size));
        hashBySize.set(size, actualSha);
      }
      if (actualSha.toLowerCase() === expectedSha) {
        matches.push({
          id: app.id ?? "unknown",
          name: app.name ?? app.id ?? "unknown",
          size,
          sha256: expectedSha,
          sourceCommit: catalog.sourceCommit ?? null,
          spikeRtCommit: catalog.spikeRtCommit ?? null,
        });
      }
    }

    dumpMetadata.matches = matches;
    dumpMetadata.catalogUrl = catalogUrl;
    dumpMetadata.catalogSourceCommit = catalog.sourceCommit ?? null;
    dumpMetadata.catalogSpikeRtCommit = catalog.spikeRtCommit ?? null;

    if (matches.length > 0) {
      elements.matchStatus.textContent = `${matches.length}件一致`;
      elements.matchStatus.className = "status-good";
      elements.matchDetails.replaceChildren();
      const list = document.createElement("ul");
      for (const match of matches) {
        const item = document.createElement("li");
        item.textContent = `${match.name} (${match.id}) / ${formatBytes(match.size)}`;
        list.append(item);
      }
      elements.matchDetails.append(list);
      appendLog(`既知ファーム一致: ${matches.map((item) => item.id).join(", ")}`);
    } else {
      elements.matchStatus.textContent = "一致なし";
      elements.matchStatus.className = "status-warn";
      elements.matchDetails.textContent =
        "現在のspike-rt-web-projectカタログには完全一致する先頭イメージがありません。";
      appendLog("既知ファームとの一致はありませんでした。");
    }
    updateControls();
    return matches;
  } catch (error) {
    elements.matchStatus.textContent = "照合失敗";
    elements.matchStatus.className = "status-error";
    elements.matchDetails.textContent = error instanceof Error ? error.message : String(error);
    appendLog(`照合失敗: ${elements.matchDetails.textContent}`);
    updateControls();
    return [];
  }
}

async function readHub() {
  if (!dfuDevice) return;
  setBusy(true);
  resetDumpResults("読み出し中");
  elements.dumpStatus.className = "";
  appendLog("SPIKE-RT領域の読み出しを開始します。フラッシュの消去・書き込みは行いません。");

  try {
    const reader = new SpikeRtReader(dfuDevice, {
      log: appendLog,
      onProgress: setProgress,
    });
    dump = await reader.read();
    const sha256 = await sha256Hex(dump);
    const programmedBytes = estimateLastProgrammedByte(dump);
    const vectors = readVectorTable(dump);

    dumpMetadata = {
      tool: "spike-rt-hub-dumper",
      dumpedAt: new Date().toISOString(),
      startAddress: hex(SPIKE_RT_START_ADDRESS),
      endAddressExclusive: hex(SPIKE_FLASH_END_ADDRESS),
      size: dump.byteLength,
      sha256,
      lastNonErasedOffset: programmedBytes,
      estimatedProgrammedEndAddress:
        programmedBytes > 0 ? hex(SPIKE_RT_START_ADDRESS + programmedBytes) : null,
      vectorTable: {
        initialStackPointer: vectors.initialStackPointer === null ? null : hex(vectors.initialStackPointer),
        resetHandler: vectors.resetHandler === null ? null : hex(vectors.resetHandler),
      },
      matches: [],
    };

    elements.dumpStatus.textContent = "読み出し完了";
    elements.dumpStatus.className = "status-good";
    elements.dumpSize.textContent = formatBytes(dump.byteLength);
    elements.dumpSha.textContent = sha256;
    elements.programmedBytes.textContent =
      programmedBytes > 0
        ? `${formatBytes(programmedBytes)} / 推定終端 ${hex(SPIKE_RT_START_ADDRESS + programmedBytes)}`
        : "すべて0xFF";
    elements.stackPointer.textContent = hex(vectors.initialStackPointer);
    elements.resetHandler.textContent = hex(vectors.resetHandler);
    elements.progress.value = 100;
    elements.progressLabel.textContent = `完了: ${formatBytes(dump.byteLength)}`;
    appendLog(`読み出し完了: SHA-256 ${sha256}`);

    await matchKnownFirmware();
  } catch (error) {
    resetDumpResults("読み出し失敗");
    elements.dumpStatus.className = "status-error";
    elements.progressLabel.textContent = "失敗";
    appendLog(`読み出し失敗: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await dfuDevice?.ensureIdle();
    } catch (recoveryError) {
      appendLog(
        `DFU状態の復旧に失敗しました。Hubを接続し直してください: ${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`,
      );
    }
  } finally {
    setBusy(false);
  }
}

elements.catalogUrl.value = DEFAULT_CATALOG_URL;
elements.browserStatus.textContent = isWebUsbAvailable()
  ? "利用可能"
  : "利用不可（HTTPS上のChrome/Edgeが必要）";
elements.browserStatus.className = isWebUsbAvailable() ? "status-good" : "status-error";

elements.connect.addEventListener("click", connectHub);
elements.disconnect.addEventListener("click", disconnectHub);
elements.read.addEventListener("click", readHub);
elements.retryMatch.addEventListener("click", async () => {
  setBusy(true);
  try {
    await matchKnownFirmware();
  } finally {
    setBusy(false);
  }
});
elements.downloadBin.addEventListener("click", () => {
  if (!dump) return;
  downloadBlob(new Blob([dump], { type: "application/octet-stream" }), dumpFilename());
});
elements.downloadMetadata.addEventListener("click", () => {
  if (!dumpMetadata) return;
  downloadBlob(
    new Blob([`${JSON.stringify(dumpMetadata, null, 2)}\n`], { type: "application/json" }),
    "spike-rt-dump-metadata.json",
  );
});

navigator.usb?.addEventListener?.("disconnect", (event) => {
  if (dfuDevice?.usbDevice === event.device) {
    appendLog("HubがUSBから切断されました。");
    clearConnectedDevice("切断済み");
  }
});

resetDumpResults();
updateControls();
