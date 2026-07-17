<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><img src="https://img.icons8.com/?size=100&id=M725CLW4L7wE&format=png&color=000000" width="28" height="28" style="vertical-align:middle;"></a></h1>

[英語](README.md)\|[スペイン語](README.es.md)\|[フランス語](README.fr.md)\|[ドイツ語](README.de.md)\|[ポルトガル語](README.pt.md)\|[日本語](README.ja.md)

## スクリーンショット -- ダッシュボード、ビューア ページ、アーケード

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## プロジェクトのミッション

Nearcade は、友人とインターネット経由でローカル協力ゲームをプレイできるオープンソース プラットフォームです。自己ホスト型セットアップ用に構築されています。ピアツーピア接続とネイティブ オペレーティング システムのオーディオおよび入力ルーティングを使用して、入力遅延を低く抑えます。

主な焦点はプライベート設定です。ホスト アプリには特別なネットワーク構成は必要ありません。視聴者は、デスクトップまたはモバイル デバイスの標準 Web ブラウザを通じて参加します。モバイル ビューア インターフェイスには、タッチ コントロールと仮想ジョイスティックが含まれています。ユーザーはプレイするために何もダウンロードする必要はありません。

## システム要件

ホスト アプリケーションを実行するには、マシンに特定のソフトウェアをインストールする必要があります。

### 必要なソフトウェア

-   Node.js バージョン 18 以降。
-   コントローラー仮想化ブリッジ用の Python 3。
-   Git を使用してソース コードをダウンロードします。

### Linuxの要件

-   PipeWire がアクティブなオーディオ サーバーである必要があります。このアプリは、PipeWire ノードを直接ターゲットにして、ゲーム オーディオをボイス チャットから分離します。 PulseAudio では動作しません。
-   アプリがネイティブ仮想ゲームパッドを作成できるように、カーネルで uinput モジュールを有効にする必要があります。
-   システムはネイティブ udev ルールを展開して、マウスとキーボードの混同フラグをブロックします。これにより、通常の Steam 入力制限が回避されます。提供されているセットアップ スクリプトがこのステップを処理します。

### Windows の要件

-   Windows でゲームパッドのサポートを有効にするには、ViGEmBus ドライバーを手動でインストールする必要があります。

### バンドルされた依存関係

このアプリは、トンネリング用の Cloudflared および Zrok バイナリをバンドルし、ネイティブに実行します。これらを手動でインストールする必要はありません。ネットワーク ルーティングは外部の Rust VPS Router にシグナリングを依存しますが、メディア ストリーミングは WebRTC 経由で行われます。

## プラットフォームサポートマトリックス

| 特徴             | Linux | 窓    | macOS |
| -------------- | ----- | ---- | ----- |
| WebRTC ストリーミング | 満杯    | 満杯   | 満杯    |
| ゲームパッドのサポート    | 満杯    | 条件付き | なし    |
| キーボードとマウスの入力   | 満杯    | 限定   | 満杯    |
| マルチコントローラー     | 満杯    | 限定   | なし    |
| オーディオの再生       | 満杯    | 満杯   | 満杯    |
| 安定性レベル         | 生産    | 実験的  | 実験的   |

## インストールとドキュメント

ほとんどのユーザーは、コンパイルされた実行可能ファイルを直接実行します。アプリケーションは起動時にシステム セットアップを自動的に処理します。

ソース コードを使用している場合、またはコンパイルされたアプリがシステムのセットアップに失敗した場合にのみ、セットアップ スクリプトを手動で実行する必要があります。 Linux セットアップ スクリプトを手動で実行するには、プロジェクトのルートから bin フォルダーに移動します。

```bash
cd bin
sudo ./linux_setup.sh
```

すべての技術的なセットアップ手順、依存関係リスト、API ガイドは専用のドキュメント ディレクトリに保管されています。これにより、メイン ページがきれいに保たれます。これらのファイルは、ホスト ダッシュボードのブック アイコンから、または以下のリンクをクリックして読むことができます。

-   [スタートガイド](src/docs/GETTING_STARTED.md)
-   [ホスト使用マニュアル](src/docs/HOST_USAGE.md)
-   [APIとセットアップガイド](src/docs/API_AND_SETUP.md)
-   [VPSサーバーのセットアップ](src/docs/VPS_SETUP.md)
-   [高度なロジックのドキュメント](src/docs/ADVANCED_LOGIC.md)
-   [ニアケード アーケード情報](src/docs/NEARCADE_ARCADE.md)

## ニアケード アーケード

このプラットフォームには、オプションのパブリック ロビー システムが含まれています。ホストは自分のセッションをアーケード グリッドにリストして、グローバル プレーヤーがローカルの協力ゲームを見つけて参加できるようにすることができます。公共ロビーは次の場所でご覧いただけます。<https://nearcade.cutefame.net>ブラウザから直接アクティブなセッションに参加できます。

## ブラウザのユーザースクリプト (ID の永続性)

デフォルトでは、表示名とチャットの色はサイトごとにのみ保存されます。このユーザースクリプトをインストールするには[タンパーモンキー](https://www.tampermonkey.net/)または任意のフォークで、あなたのアイデンティティは、Cloudflare トンネル、zrok、localhost など、すべての Nearcade セッションにわたってあなたに従います。

[Nearcade ID の永続的なインストール](src/scripts/nearcade-identity-persist.user.js)

このプロジェクトでは、コード生成と構造計画に人工知能の大規模言語モデルを使用します。
