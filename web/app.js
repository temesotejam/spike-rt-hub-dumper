import {
  connectSpikeDfu,
  isWebUsbAvailable,
  SPIKE_DFU_PRODUCT_ID,
  SPIKE_DFU_VENDOR_ID,
} from "./dfu.js";
import {
  estimateLastProgrammedByte,
  readVectorTable,
  SPIKE_FLASH_BYTES,
  SPIKE_FLASH_END_ADDRESS,
  SPIKE_FLASH_START_ADDRESS,
  SPIKE_RT_REGION_BYTES,
  SPIKE_RT_START_ADDRESS,
  SpikeRtReader,
} from "./reader.js";
import { SpikeRtRestorer, validateRestoreImage } from "./restore.js";

const DEFAULT_CATALOG_URL =
  "https://temesotejam.github.io/spike-rt-web-project/firmware/catalog.json";
const PREFIX_BYTES = SPIKE_RT_START_ADDRESS - SPIKE_FLASH_START_ADDRESS;

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
  readFull: document.querySelector("#read-full"),
  fullProgress: document.querySelector("#full-progress"),
  fullProgressLabel: document.querySelector("#full-progress-label"),
  fullStatus: document.querySelector("#full-status"),
  fullSize: document.querySelector("#full-size"),
  fullSha: document.querySelector("#full-sha"),
  prefixSha: document.querySelector("#prefix-sha"),
  fullProgramSha: document.querySelector("#full-program-sha"),
  downloadFullBin: document.querySelector("#download-full-bin"),
  downloadFullMetadata: document.querySelector("#download-full-metadata"),
  restoreFile: document.querySelector("#restore-file"),
  restoreMetadata: document.querySelector("#restore-metadata"),
  restoreFileStatus: document.querySelector("#restore-file-status"),
  restoreFileSize: document.querySelector("#restore-file-size"),
  restoreFileSha: document.querySelector("#restore-file-sha"),
  restoreMetadataStatus: document.querySelector("#restore-metadata-status"),
  restoreStatus: document.querySelector("#restore-status"),
  restoreReadbackSha: document.querySelector("#restore-readback-sha"),
  restoreConfirm: document.querySelector("#restore-confirm"),
  restore: document.querySelector("#restore"),
  restoreProgress: document.querySelector("#restore-progress"),
  restoreProgressLabel: document.querySelector("#restore-progress-label"),
  matchStatus: document.querySelector("#match-status"),
  matchDetails: document.querySelector("#match-details"),
  catalogUrl: document.querySelector("#catalog-url"),
  retryMatch: document.querySelector("#retry-match"),
  log: document.querySelector("#log"),
};

let dfuDevice = null;
let dump = null;
let dumpMetadata = null;
let fullDump = null;
let fullDumpMetadata = null;
let restoreImage = null;
let restoreImageSha = null;
let restoreMetadataObject = null;
let restoreMetadataValid = true;
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
  elements.readFull.disabled = busy || !dfuDevice;
  elements.downloadBin.disabled = busy || !dump;
  elements.downloadMetadata.disabled = busy || !dumpMetadata;
  elements.downloadFullBin.disabled = busy || !fullDump;
  elements.downloadFullMetadata.disabled = busy || !fullDumpMetadata;
  elements.retryMatch.disabled = busy || !dump;
  elements.catalogUrl.disabled = busy;
  elements.restoreFile.disabled = busy;
  elements.restoreMetadata.disabled = busy;
  elements.restoreConfirm.disabled = busy;
  elements.restore.disabled =
    busy ||
    !dfuDevice ||
    !restoreImage ||
    !restoreImageSha ||
    !restoreMetadataValid ||
    !elements.restoreConfirm.checked;
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

function resetFullResults(status = "未読み出し") {
  fullDump = null;
  fullDumpMetadata = null;
  elements.fullStatus.textContent = status;
  elements.fullStatus.className = "";
  elements.fullSize.textContent = "—";
  elements.fullSha.textContent = "—";
  elements.prefixSha.textContent = "—";
  elements.fullProgramSha.textContent = "—";
  elements.fullProgress.value = 0;
  elements.fullProgressLabel.textContent = "待機中";
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

function updateReadProgress(progress, label, done, total, prefix = "読み出し中") {
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const percent = ratio * 100;
  progress.value = percent;
  label.textContent = `${prefix}: ${Math.round(percent)}% (${formatBytes(done)} / ${formatBytes(total)})`;
}

function setProgress(done, total) {
  updateReadProgress(elements.progress, elements.progressLabel, done, total);
}

function setFullProgress(done, total) {
  updateReadProgress(elements.fullProgress, elements.fullProgressLabel, done, total);
}

function setRestoreProgress(phase, done, total) {
  const names = {
    erase: "セクタ消去",
    write: "書き戻し",
    verify: "全域読み戻し検証",
  };
  updateReadProgress(
    elements.restoreProgress,
    elements.restoreProgressLabel,
    done,
    total,
    names[phase] ?? phase,
  );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function dumpFilename() {
  return `spike-rt-program-backup-08008000-${timestampForFilename()}.bin`;
}

function fullDumpFilename() {
  return `spike-prime-full-flash-08000000-${timestampForFilename()}.bin`;
}

function createProgramMetadata(buffer, sha256, source = "hub-read") {
  const programmedBytes = estimateLastProgrammedByte(buffer);
  const vectors = readVectorTable(buffer);
  return {
    tool: "spike-rt-hub-dumper",
    kind: "spike-rt-program-backup",
    source,
    dumpedAt: new Date().toISOString(),
    startAddress: hex(SPIKE_RT_START_ADDRESS),
    endAddressExclusive: hex(SPIKE_FLASH_END_ADDRESS),
    size: buffer.byteLength,
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
}

function showProgramMetadata(metadata) {
  elements.dumpStatus.textContent = "読み出し完了";
  elements.dumpStatus.className = "status-good";
  elements.dumpSize.textContent = formatBytes(metadata.size);
  elements.dumpSha.textContent = metadata.sha256;
  elements.programmedBytes.textContent =
    metadata.lastNonErasedOffset > 0
      ? `${formatBytes(metadata.lastNonErasedOffset)} / 推定終端 ${metadata.estimatedProgrammedEndAddress}`
      : "すべて0xFF";
  elements.stackPointer.textContent = metadata.vectorTable.initialStackPointer ?? "—";
  elements.resetHandler.textContent = metadata.vectorTable.resetHandler ?? "—";
  elements.progress.value = 100;
  elements.progressLabel.textContent = `完了: ${formatBytes(metadata.size)}`;
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
    if (!response.ok) throw new Error(`catalog.jsonの取得に失敗しました (${response.status})。`);
    const catalog = await response.json();
    if (!Array.isArray(catalog.apps)) throw new Error("catalog.jsonにapps配列がありません。");

    const hashBySize = new Map();
    const matches = [];
    for (const app of catalog.apps) {
      const size = Number(app.size);
      const expectedSha = String(app.sha256 ?? "").toLowerCase();
      if (!Number.isInteger(size) || size <= 0 || size > dump.byteLength || !expectedSha) continue;
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

    if (dumpMetadata) {
      dumpMetadata.matches = matches;
      dumpMetadata.catalogUrl = catalogUrl;
      dumpMetadata.catalogSourceCommit = catalog.sourceCommit ?? null;
      dumpMetadata.catalogSpikeRtCommit = catalog.spikeRtCommit ?? null;
    }

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
  appendLog("SPIKE-RT領域の読み出しを開始します。消去・書き込みは行いません。");
  try {
    const reader = new SpikeRtReader(dfuDevice, { log: appendLog, onProgress: setProgress });
    dump = await reader.read(SPIKE_RT_START_ADDRESS, SPIKE_RT_REGION_BYTES);
    const sha256 = await sha256Hex(dump);
    dumpMetadata = createProgramMetadata(dump, sha256);
    showProgramMetadata(dumpMetadata);
    appendLog(`SPIKE-RT領域バックアップ完了: SHA-256 ${sha256}`);
    await matchKnownFirmware();
  } catch (error) {
    resetDumpResults("読み出し失敗");
    elements.dumpStatus.className = "status-error";
    elements.progressLabel.textContent = "失敗";
    appendLog(`読み出し失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

async function readFullFlash() {
  if (!dfuDevice) return;
  setBusy(true);
  resetFullResults("読み出し中");
  appendLog("内部Flash 1 MiB全体の読み出しを開始します。これは読み出し専用です。");
  try {
    const reader = new SpikeRtReader(dfuDevice, { log: appendLog, onProgress: setFullProgress });
    fullDump = await reader.read(SPIKE_FLASH_START_ADDRESS, SPIKE_FLASH_BYTES);
    const fullSha = await sha256Hex(fullDump);
    const prefixSha = await sha256Hex(fullDump.slice(0, PREFIX_BYTES));
    const programSha = await sha256Hex(fullDump.slice(PREFIX_BYTES));
    fullDumpMetadata = {
      tool: "spike-rt-hub-dumper",
      kind: "spike-prime-full-flash-backup-read-only",
      dumpedAt: new Date().toISOString(),
      startAddress: hex(SPIKE_FLASH_START_ADDRESS),
      endAddressExclusive: hex(SPIKE_FLASH_END_ADDRESS),
      size: fullDump.byteLength,
      sha256: fullSha,
      protectedPrefix: {
        startAddress: hex(SPIKE_FLASH_START_ADDRESS),
        endAddressExclusive: hex(SPIKE_RT_START_ADDRESS),
        size: PREFIX_BYTES,
        sha256: prefixSha,
      },
      spikeRtRegion: {
        startAddress: hex(SPIKE_RT_START_ADDRESS),
        endAddressExclusive: hex(SPIKE_FLASH_END_ADDRESS),
        size: SPIKE_RT_REGION_BYTES,
        sha256: programSha,
      },
      restorePolicy: "The built-in restore function never writes 0x08000000-0x08008000.",
    };
    elements.fullStatus.textContent = "読み出し完了";
    elements.fullStatus.className = "status-good";
    elements.fullSize.textContent = formatBytes(fullDump.byteLength);
    elements.fullSha.textContent = fullSha;
    elements.prefixSha.textContent = prefixSha;
    elements.fullProgramSha.textContent = programSha;
    elements.fullProgress.value = 100;
    elements.fullProgressLabel.textContent = `完了: ${formatBytes(fullDump.byteLength)}`;
    appendLog(`1 MiB全Flashバックアップ完了: SHA-256 ${fullSha}`);
    if (dumpMetadata && dumpMetadata.sha256 === programSha) {
      appendLog("全Flash内のSPIKE-RT領域SHA-256は、992 KiBバックアップと一致しています。");
    }
  } catch (error) {
    resetFullResults("読み出し失敗");
    elements.fullStatus.className = "status-error";
    elements.fullProgressLabel.textContent = "失敗";
    appendLog(`全Flash読み出し失敗: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

function normalizeAddress(value) {
  return String(value ?? "").toLowerCase();
}

function evaluateRestoreMetadata() {
  restoreMetadataValid = true;
  elements.restoreMetadataStatus.className = "";
  if (!restoreMetadataObject) {
    elements.restoreMetadataStatus.textContent = "未選択（任意）";
    updateControls();
    return;
  }
  try {
    if (normalizeAddress(restoreMetadataObject.startAddress) !== "0x08008000") {
      throw new Error("startAddressが0x08008000ではありません");
    }
    if (normalizeAddress(restoreMetadataObject.endAddressExclusive) !== "0x08100000") {
      throw new Error("endAddressExclusiveが0x08100000ではありません");
    }
    if (Number(restoreMetadataObject.size) !== SPIKE_RT_REGION_BYTES) {
      throw new Error("sizeが992 KiBではありません");
    }
    const metadataSha = String(restoreMetadataObject.sha256 ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(metadataSha)) throw new Error("SHA-256がありません");
    if (restoreImageSha && metadataSha !== restoreImageSha.toLowerCase()) {
      throw new Error("選択したbinのSHA-256と一致しません");
    }
    elements.restoreMetadataStatus.textContent = restoreImageSha
      ? "binとSHA-256一致"
      : "形式OK・bin選択待ち";
    elements.restoreMetadataStatus.className = "status-good";
  } catch (error) {
    restoreMetadataValid = false;
    elements.restoreMetadataStatus.textContent = `不一致: ${error instanceof Error ? error.message : String(error)}`;
    elements.restoreMetadataStatus.className = "status-error";
  }
  updateControls();
}

async function selectRestoreFile() {
  restoreImage = null;
  restoreImageSha = null;
  elements.restoreFileStatus.textContent = "未選択";
  elements.restoreFileStatus.className = "";
  elements.restoreFileSize.textContent = "—";
  elements.restoreFileSha.textContent = "—";
  elements.restoreStatus.textContent = "未実行";
  elements.restoreStatus.className = "";
  elements.restoreReadbackSha.textContent = "—";
  elements.restoreConfirm.checked = false;
  const file = elements.restoreFile.files?.[0];
  if (!file) {
    evaluateRestoreMetadata();
    updateControls();
    return;
  }
  setBusy(true);
  try {
    const buffer = await file.arrayBuffer();
    validateRestoreImage(buffer);
    const sha = await sha256Hex(buffer);
    restoreImage = buffer;
    restoreImageSha = sha;
    elements.restoreFileStatus.textContent = `${file.name} / 使用可能`;
    elements.restoreFileStatus.className = "status-good";
    elements.restoreFileSize.textContent = formatBytes(buffer.byteLength);
    elements.restoreFileSha.textContent = sha;
    appendLog(`復元ファイルを検査しました: ${file.name}, SHA-256 ${sha}`);
  } catch (error) {
    elements.restoreFileStatus.textContent = `使用不可: ${error instanceof Error ? error.message : String(error)}`;
    elements.restoreFileStatus.className = "status-error";
    appendLog(`復元ファイル拒否: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
    evaluateRestoreMetadata();
  }
}

async function selectRestoreMetadata() {
  restoreMetadataObject = null;
  const file = elements.restoreMetadata.files?.[0];
  if (!file) {
    evaluateRestoreMetadata();
    return;
  }
  setBusy(true);
  try {
    restoreMetadataObject = JSON.parse(await file.text());
  } catch (error) {
    restoreMetadataValid = false;
    elements.restoreMetadataStatus.textContent = `読込失敗: ${error instanceof Error ? error.message : String(error)}`;
    elements.restoreMetadataStatus.className = "status-error";
  } finally {
    setBusy(false);
    if (restoreMetadataObject) evaluateRestoreMetadata();
    else updateControls();
  }
}

async function restoreHub() {
  if (!dfuDevice || !restoreImage || !restoreImageSha || !restoreMetadataValid) return;
  if (!elements.restoreConfirm.checked) return;
  const accepted = window.confirm(
    `SPIKE-RT領域 0x08008000–0x08100000 を消去してバックアップへ復元します。\n\nSHA-256:\n${restoreImageSha}\n\n先頭32 KiB (0x08000000–0x08008000) は変更しません。\n続行しますか？`,
  );
  if (!accepted) {
    appendLog("復元操作をキャンセルしました。");
    return;
  }

  setBusy(true);
  elements.restoreStatus.textContent = "復元中";
  elements.restoreStatus.className = "status-warn";
  elements.restoreReadbackSha.textContent = "—";
  elements.restoreProgress.value = 0;
  elements.restoreProgressLabel.textContent = "復元準備中";
  appendLog(`復元開始: expected SHA-256 ${restoreImageSha}`);

  try {
    const restorer = new SpikeRtRestorer(dfuDevice, {
      log: appendLog,
      onProgress: setRestoreProgress,
    });
    const readback = await restorer.restore(restoreImage);
    const readbackSha = await sha256Hex(readback);
    elements.restoreReadbackSha.textContent = readbackSha;
    if (readbackSha.toLowerCase() !== restoreImageSha.toLowerCase()) {
      throw new Error(`最終SHA-256が一致しません: ${readbackSha}`);
    }

    elements.restoreStatus.textContent = "完全一致・復元完了";
    elements.restoreStatus.className = "status-good";
    elements.restoreProgress.value = 100;
    elements.restoreProgressLabel.textContent = "完了: 992 KiB全域検証済み";
    appendLog(`復元完了: 読み戻しSHA-256 ${readbackSha}（元バックアップと完全一致）`);
    appendLog("先頭32 KiBは変更していません。USBを抜いてHubを通常起動できます。");

    dump = readback;
    dumpMetadata = createProgramMetadata(readback, readbackSha, "post-restore-readback");
    showProgramMetadata(dumpMetadata);
  } catch (error) {
    elements.restoreStatus.textContent = "復元失敗・Hubを通常起動する前に確認してください";
    elements.restoreStatus.className = "status-error";
    elements.restoreProgressLabel.textContent = "失敗";
    appendLog(`復元失敗: ${error instanceof Error ? error.message : String(error)}`);
    appendLog("復元失敗時はUSBを抜かず、ログを保存して再接続・再復元を検討してください。");
  } finally {
    elements.restoreConfirm.checked = false;
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
elements.readFull.addEventListener("click", readFullFlash);
elements.retryMatch.addEventListener("click", async () => {
  setBusy(true);
  try {
    await matchKnownFirmware();
  } finally {
    setBusy(false);
  }
});
elements.restoreFile.addEventListener("change", selectRestoreFile);
elements.restoreMetadata.addEventListener("change", selectRestoreMetadata);
elements.restoreConfirm.addEventListener("change", updateControls);
elements.restore.addEventListener("click", restoreHub);

elements.downloadBin.addEventListener("click", () => {
  if (!dump) return;
  downloadBlob(new Blob([dump], { type: "application/octet-stream" }), dumpFilename());
});
elements.downloadMetadata.addEventListener("click", () => {
  if (!dumpMetadata) return;
  downloadBlob(
    new Blob([`${JSON.stringify(dumpMetadata, null, 2)}\n`], { type: "application/json" }),
    "spike-rt-program-backup-metadata.json",
  );
});
elements.downloadFullBin.addEventListener("click", () => {
  if (!fullDump) return;
  downloadBlob(new Blob([fullDump], { type: "application/octet-stream" }), fullDumpFilename());
});
elements.downloadFullMetadata.addEventListener("click", () => {
  if (!fullDumpMetadata) return;
  downloadBlob(
    new Blob([`${JSON.stringify(fullDumpMetadata, null, 2)}\n`], { type: "application/json" }),
    "spike-prime-full-flash-metadata.json",
  );
});

navigator.usb?.addEventListener?.("disconnect", (event) => {
  if (dfuDevice?.usbDevice === event.device) {
    appendLog("HubがUSBから切断されました。");
    clearConnectedDevice("切断済み");
  }
});

resetDumpResults();
resetFullResults();
evaluateRestoreMetadata();
updateControls();
