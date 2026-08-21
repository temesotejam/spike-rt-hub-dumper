# SPIKE-RT Hub Dumper

SPIKE Prime Hub を DFU モードで接続し、ブラウザの WebUSB から SPIKE-RT 領域を読み出すための読み出し専用ツールです。

## できること

- LEGO SPIKE Prime Hub の DFU デバイス (VID `0x0694`, PID `0x0008`) に WebUSB で接続
- SPIKE-RT 領域 `0x08008000` から `0x08100000` 直前までの 992 KiB を読み出し
- 読み出した内容を `.bin` として保存
- 全領域 SHA-256、最後の非 `0xFF`、ベクタテーブル先頭を表示
- `spike-rt-web-project` の `catalog.json` と照合し、既知の `asp.bin` と先頭イメージが完全一致するプログラムを特定
- 読み出し情報を `metadata.json` として保存

## 安全側の制限

このツールにはフラッシュのセクタ消去、ファームウェア書き込み、再起動機能を実装していません。読み出し開始アドレスとサイズも固定しており、SPIKE-RT 領域以外は拒否します。

DfuSe のアドレスポインタ設定には DFU `DNLOAD` リクエストを使いますが、送るのは Set Address Pointer コマンドだけで、Flash データの書き込みや消去は行いません。その後のデータ取得は `UPLOAD` で行います。

## Hub の接続

1. Hub の電源を切り、USB ケーブルを抜く
2. Bluetooth ボタンを押したまま USB ケーブルを接続する
3. 赤・緑・青の繰り返し点滅になったらボタンを離す
4. GitHub Pages を Chrome / Edge で開き「Hubに接続」を押す
5. `LEGO Technic Large Hub in DFU Mode` を選択する

Windows では初回のみ WinUSB ドライバーの割り当てが必要な場合があります。

## 既知ファーム照合

既定の照合先は次です。

```text
https://temesotejam.github.io/spike-rt-web-project/firmware/catalog.json
```

`catalog.json` の各エントリにある `size` と `sha256` を使い、dump の先頭からその `size` 分だけ SHA-256 を計算します。これにより、992 KiB 全体を保存した dump でも元の `asp.bin` と比較できます。

## 開発

```bash
npm test
```

Web 部分はビルド不要の静的 HTML / JavaScript です。`main` への push 後、GitHub Actions から GitHub Pages に配置します。

## 注意

Hub から元の C ソースコードをそのまま復元するツールではありません。取得できるのはコンパイル済み Flash イメージです。既知ファームと一致した場合は、そのビルド元を識別できます。

## ライセンス

MIT。WebUSB / DFU 基盤は同一所有者の `spike-rt-web-project` の実装をベースに整理しています。
