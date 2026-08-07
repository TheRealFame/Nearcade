# VPS セットアップ

(CGNAT または厳格なファイアウォールが原因で) ポートを開けない場合は、Nearcade トラフィックを安価なクラウド VPS 経由でルーティングできます。

### 1. 前提条件
- Linux (Ubuntu、Debian、または Oracle Cloud Linux) を実行するクラウド VPS
- VPS への SSH アクセス
- ローカルホスト PC にインストールされた Nearcade

### 2. VPS ルーターの構成
Nearcade VPS ルーター (`/vps` ディレクトリ) は、WebSocket シグナリングと WebRTC ハンドシェイク トラフィックのプロキシを処理します。
VPS で、Nearcade リリースをダウンロードし、ルーターを実行します。
```bash
./nearcade-router --port 8080
```

### 3. ホストに接続する
Nearcade アプリ設定の **専用トンネル プロバイダー** で、VPS IP とポートを構成します。
構成が完了すると、視聴者がホーム ネットワークに直接接続する必要がなく、すべての P2P ハンドシェイク データが VPS からバウンスされます。
