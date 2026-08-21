# SPIKE-RT Hub Backup & Restore

SPIKE Prime Hub を DFU モードで接続し、ブラウザの WebUSB から Flash をバックアップし、必要な場合は SPIKE-RT 領域を保存イメージへ復元するツールです。

## できること

- LEGO SPIKE Prime Hub の DFU デバイス (VID `0x0694`, PID `0x0008`) に WebUSB で接続
- SPIKE-RT 領域 `0x08008000` から `0x08100000` 直前までの 992 KiB をバックアップ
- 内部 Flash 全体 `0x08000000` から `0x08100000` 直前までの 1 MiB を読み出し専用で追加バックアップ
- バックアップを `.bin` として保存
- SHA-256、最後の非 `0xFF`、ベクタテーブル先頭を表示
- `spike-rt-web-project` の `catalog.json` と照合し、既知の `asp.bin` と完全一致するプログラムを特定
- 読み出し情報を `metadata.json` として保存
- 保存した 992 KiB の SPIKE-RT バックアップを `0x08008000–0x08100000` へ復元
- 復元後に 992 KiB 全域を再読み出しし、1 byte ずつ比較して完全一致を確認

## 復元時の安全境界

復元機能には次の制約をコード側で固定しています。

- 復元入力は **正確に 1,015,808 bytes (992 KiB)** の `.bin` だけ
- 1 MiB の full-flash バックアップは復元入力として拒否
- 消去・書き込み開始アドレスは常に `0x08008000`
- `0x08000000–0x08008000` の先頭 32 KiB は復元機能から消去・書き込みしない
- STM32F413 のセクタマップに従い、復元対象セクタは `0x08008000` 以降だけ
- UI では復元ファイルの SHA-256 を事前計算
- `metadata.json` を選択した場合は範囲・サイズ・SHA-256 を `.bin` と照合
- 明示的な確認チェックと最終確認ダイアログを通らないと復元を開始しない
- 書き戻し後は全 992 KiB を再読み出しし、byte-for-byte 比較
- 最終読み戻し SHA-256 も表示
- 復元成功後は自動再起動せず、ユーザーが検証結果を確認してから通常起動する

1 MiB full-flash バックアップは、先頭 32 KiB も含めて「現状を保存しておく」ための保険です。このツールから先頭 32 KiB を書き戻す機能は意図的に用意していません。

## 借用機体での推奨手順

別プログラムを書き込む前に、次の順で保存してください。

1. 992 KiB の SPIKE-RT 領域バックアップを取得
2. `program-backup.bin` と `metadata.json` を保存
3. 1 MiB 全 Flash バックアップを取得
4. `full-flash-1MiB.bin` と full-flash metadata を保存
5. 992 KiB バックアップ SHA-256 と、1 MiB バックアップ内の SPIKE-RT 領域 SHA-256 が一致していることを確認
6. その後で別の SPIKE-RT プログラムを書き込む

返却前は、保存した 992 KiB `program-backup.bin` を復元画面で選び、復元後の読み戻し SHA-256 が元バックアップと一致したことを確認します。

## Hub の接続

1. Hub の電源を切り、USB ケーブルを抜く
2. Bluetooth ボタンを押したまま USB ケーブルを接続する
3. 赤・緑・青の繰り返し点滅になったらボタンを離す
4. GitHub Pages を Chrome / Edge で開き「Hubに接続」を押す
5. `LEGO Technic Large Hub in DFU Mode` を選択する

Windows では初回のみ WinUSB ドライバーの割り当てが必要な場合があります。

## 読み出し方式

DfuSe の Set Address Pointer (`0x21`) を使い、最大 64 KiB ごとにアドレスを設定し直して `DFU_UPLOAD` block 2 から読み出します。SPIKE Prime + WinUSB/WebUSB 実機で `GETSTATE` が transfer error になったため、状態復帰は `dfu-util` と同じ `DFU_ABORT -> DFU_GETSTATUS` を使用します。

## 復元方式

DfuSe の Erase (`0x41`) で `0x08008000` 以降の対象セクタだけを消去し、Set Address Pointer (`0x21`) と `DFU_DNLOAD` block 2 以降でバックアップ内容を書き戻します。その後、同じ実機読み出し経路を使って全 992 KiB を再取得し、元イメージと比較します。

途中で復元に失敗した場合は、通常起動する前にログを確認し、DFU モードのまま再接続して復元をやり直してください。

## 既知ファーム照合

既定の照合先は次です。

```text
https://temesotejam.github.io/spike-rt-web-project/firmware/catalog.json
```

`catalog.json` の各エントリにある `size` と `sha256` を使い、992 KiB バックアップ先頭からその `size` 分だけ SHA-256 を計算します。

## 開発

```bash
npm test
```

CI では Web JavaScript の構文チェック、固定読み出し範囲、先頭 32 KiB の消去禁止、992 KiB 復元、全域読み戻し検証をテストします。

Web 部分はビルド不要の静的 HTML / JavaScript です。`main` への push 後、GitHub Actions から GitHub Pages に配置します。

## 注意

Hub から元の C ソースコードをそのまま復元するツールではありません。取得・復元するのはコンパイル済み Flash イメージです。

## ライセンス

MIT。WebUSB / DFU 基盤は同一所有者の `spike-rt-web-project` の実装をベースに整理しています。
