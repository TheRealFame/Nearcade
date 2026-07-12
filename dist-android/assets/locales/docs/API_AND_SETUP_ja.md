# API とシステムのセットアップ

## 手動起動
開発またはトラブルシューティングを行っている場合は、コンパイルされた実行可能ファイルを使用する代わりに、コンポーネントを手動で実行することができます。 Nearsec では、2 つの別個のプロセスを同時に実行する必要があります。これらは、Python 入力ドライバーと Node.js Web サーバーです。

### Linux での手動セットアップ
Linux では、uinput 経由で仮想コントローラーをカーネルに直接挿入するには root 権限が必要です。

入力ドライバー用の端子 1:
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Web サーバー用のターミナル 2:
```bash
cd Nearcade
npm install
npm run electron
```

### Windows での手動セットアップ
Windows では、コントローラーをエミュレートするために ViGEmBus ドライバーが必要です。
1. ViGEmBus ドライバーをダウンロードしてインストールします。
2. Python 3 および Node 18 以降がインストールされていることを確認します。

入力ドライバー用の端子 1:
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Web サーバー用のターミナル 2:
```powershell
cd Nearcade
npm install
npm run electron
```

## 環境設定
機密性の高いトークンのハードコーディングを防ぐために、Nearsec はルート ディレクトリにある環境ファイルに依存します。

.env という名前のファイルを作成し、それに特定のキーを入力します。
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## 内部 Express API エンドポイント
Nearsec ノード サーバーは、バックエンドを動的に制御するためにローカル HTTP POST エンドポイントを公開します。

/api/force-route によるオーディオルーティング
* ペイロード: { "nodeProperty": "target_node_id" }
* アクション: PipeWire が特定のターゲット ノードを NearsecVirtualCapture シンクに動的にリンクするように強制します。

/api/restart-game によるプロセス管理
* アクション: キャプチャ シーケンスを再開します。

このプロジェクトでは、コード生成と構造計画に人工知能の大規模言語モデルを使用します。
