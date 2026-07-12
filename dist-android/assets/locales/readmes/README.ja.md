<p align="left">
  <img src="assets/NearcadeLogo.png" width="160" height="140">
<h1>Nearcade</h1>

[英語](README.md)\|[スペイン語](assets/locales/readmes/README.es.md)\|[フランス語](assets/locales/readmes/README.fr.md)\|[ドイツ語](assets/locales/readmes/README.de.md)\|[ポルトガル語](assets/locales/readmes/README.pt.md)\|[日本語](assets/locales/readmes/README.ja.md)

## スクリーンショット -- ダッシュボード、ビューア ページ、アーケード

<div align="center">
  <img src="assets/screenshots/nearsec-client-home.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-host.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-viewer.png" alt="Nearsec Viewer" width="45%">
  <img src="assets/screenshots/nearsec-arcade.png" alt="Nearsec Arcade" width="45%">
</div>

## プロジェクトの説明

Nearcade は、インターネット経由で友達とローカル協力ゲームをプレイできる、低遅延のオープンソース プラットフォームです。 Nearcade は、UDP ファースト ストリーミングと組み込みブラウザ ハードウェア エンコーダに WebRTC を活用することで、商用クラウド ゲーム プラットフォームに匹敵するほぼ知覚できないレイテンシを提供し、セルフホスト インスタンス向けに特別に調整されています。

大規模なデータセンター パイプやカスタム QUIC/VP9 ハードウェア エンコーダに依存した従来のクラウド ゲーム ソリューションとは異なり、Nearcade は標準の家庭用インターネット接続上でエレガントに動作するように最適化されています。

## テクノロジースタック

-   **交通機関**: WebRTC はジッター バッファリングと NAT トラバーサルを自動的に処理します。
-   **ディストリビューター**: 複数の人にストリーミングするときにホーム ネットワークのアップロード帯域幅が過負荷になるのを防ぐために、これを SFU (選択的転送ユニット) と組み合わせるか、組み込みのポート転送およびトンネリング オプションを使用できます。
-   **エンコーダー**: ソフトウェアは WebRTC API 経由でシステムのハードウェア エンコーディング (NVENC、VAAPI) にアクセスし、接続品質に基づいて最適化された H.264 または VP8/VP9 ストリームを配信します。

* * *

## プラットフォームのサポート

| 特徴                 |  Linux |    窓    |  macOS  |
| ------------------ | :----: | :-----: | :-----: |
| **WebRTC ストリーミング** |       |        |        |
| **ゲームパッドのサポート**    |   フル  | ⚠条件付き¹ |    なし  |
| **キーボード/マウス入力**    |   フル  |   ⚠限定  |    フル  |
| **モーションコントロール**    |       |        |        |
| **マルチコントローラー**     |       |   ⚠限定  |        |
| **オーディオの再生**       |       |        |        |
| **ディスプレイキャプチャ**    |       |        |        |
| **安定性**            | **生産** | **実験的** | **実験的** |

¹ Windows ゲームパッドが必要です[ViGEmBus ドライバー](https://github.com/nefarius/ViGEmBus/releases)

**[→ 詳細なプラットフォームセットアップガイド](PLATFORM_SETUP.md)**— 各プラットフォームの段階的な手順、トラブルシューティング、回避策。

* * *

## はじめる

### 何`./start`自動的に処理します

-   走る`npm install`もし`node_modules`電子を含む欠落しています。
-   ロードします`uinput`Linux 上のカーネル モジュール (経由)`sudo modprobe uinput`).
-   ヘッドレスに戻ります`node server.js`Electron がインストールされていない場合はモード。

### 自分で設定しなければならないもの

| 依存                        | 必須            | インストール                                   |
| ------------------------- | ------------- | ---------------------------------------- |
| **Node.js**(v18+)         | すべて           | [nodejs.org](https://nodejs.org)または`nvm` |
| **パイソン3**+`python-uinput` | コントローラー入力の仮想化 | `sudo ./linux_setup.sh`(Linux のみ、1 回限り)  |
| **uinput カーネルモジュール**      | コントローラー入力の仮想化 | に含まれるもの`linux_setup.sh`                  |

> **コントローラーは Python がセットアップされていないと機能しません。**アプリは引き続き起動し、正常にストリーミングされますが、視聴者はゲームパッドやキーボード入力をホストに送信できないだけです。走る`sudo ./linux_setup.sh`クローン作成後に 1 回実行して有効にします。

> **Windows/macOSセットアップの場合**、 見る[PLATFORM_SETUP.md](PLATFORM_SETUP.md)各プラットフォームの詳細な手順、要件、既知の制限については、を参照してください。

### 段階的に

**Linux (推奨 - 完全にサポート)**

```bash
# 1. One-time system setup (installs python-uinput, udev rules, uinput)
sudo ./linux_setup.sh

# 2. Every subsequent launch
./start
```

**Windows / macOS**_(実験的 — を参照[PLATFORM_SETUP.md](PLATFORM_SETUP.md))_

```bash
# For detailed setup instructions, troubleshooting, and known limitations:
# → Read: PLATFORM_SETUP.md

./start
```

Node.js がすでにインストールされている必要があります。スクリプトは次のように終了します。`Node.js missing`見つからない場合。

### 友達と共有する

1.  クリック**共有を開始する**ホスト インターフェイスでキャプチャを開始します。
2.  トンネルプロバイダー (クラウドフレア推奨 - 無料、アカウント不要) を選択するか、TCP 3000 でポート転送を設定します。
3.  提供されたリンクと PIN を友達と共有します。それでおしまい。

* * *

## 安全

-   **PINレート制限**— PIN の試行が繰り返し失敗すると、WebSocket サーバーは IP をロックアウトします。
-   **バージョンパリティチェック**— クライアントのバージョンがホストと異なる場合、視聴者にはすぐに警告が表示されます。
-   **入力絶縁**— 視聴者ごとの厳格な権限により、クライアントが未承認のキーボード入力を送信したり、所有していないゲームパッド スロットをオーバーライドしたりすることが防止されます。

* * *

## トラブルシューティング

### コントローラーが動作しない

走る`sudo ./linux_setup.sh`まだ行っていない場合は。それを確認してください`/dev/uinput`存在し、書き込み可能です。端末がログを記録します`[uinput] sidecar started`打ち上げが成功したとき。

### ストリームに音声がありません

Wayland/PipeWire では、オーディオ キャプチャは画面共有ポータル ダイアログを通じて処理されます。共有ダイアログが表示されたら、**「音声を共有」**にチェックが入っています。共有後も音声が表示されない場合、アプリは自動的に PipeWire ループバック フォールバックを試み、結果を記録します。

### WebRTC ハンドシェイクの失敗 / GPU エラー

見たら`vulkan_swap_chain.cc Swapchain is suboptimal`または同様の GPU がターミナルでクラッシュした場合、グラフィック ドライバーが Electron のハードウェア アクセラレーション フラグを拒否しています。

1.  開ける`electron-main.js`.
2.  を見つけてください`app.commandLine.appendSwitch('enable-features', ...)`ブロック。
3.  フラグを 1 つずつ削除します (例:`VaapiVideoEncoder`,`VaapiVideoDecoder`) ストリームが安定するまで。
4.  それらを削除する必要がある場合、アプリはソフトウェア エンコード (VP8/VP9) に戻ります。CPU 使用率は高くなりますが、安定しています。

### Electron をゼ​​ロから再構築する

もし`npm install`アーキテクチャに適した Electron バイナリのプルに失敗します。

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

通常とは異なるアーキテクチャでは、ソースから Electron をビルドする必要がある場合があります。`electron/build-tools`, しかし、これが必要になることはほとんどありません。

* * *

## 現在の進捗状況

-   統合された WebRTC キャプチャ コントロールを備えたコア ホスト UI。
-   ポート転送、Cloudflared、自動トンネリングの統合。
-   コントローラ入力仮想化による`uinput`シームレスな Steam 入力バイパスを実現します。
-   ユーザーが選択可能な劣化設定による動的なビットレート スケーリング。
-   仮想ジョイスティックとオプションのジャイロ照準を備えたモバイル タッチ UI。
-   アーケード モード — 他の人が発見して参加できるように、Nearsec Arcade にセッションを公開します。

* * *

_このプロジェクトでは、コード生成に LLM を使用しました。_
