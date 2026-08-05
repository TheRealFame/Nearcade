# API e configuração do sistema

## Inicialização manual
Se você estiver desenvolvendo ou solucionando problemas, poderá executar os componentes manualmente em vez de usar o executável compilado. Nearsec requer dois processos separados para serem executados simultaneamente. Estes são o driver de entrada Python e o servidor Web Node.js.

### Configuração manual no Linux
O Linux requer privilégios de root para injetar controladores virtuais diretamente no kernel via uinput.

Terminal 1 para o driver de entrada:
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Terminal 2 para o servidor Web:
```bash
cd Nearcade
npm install
npm run electron
```

### Configuração manual no Windows
O Windows requer o driver ViGEmBus para emular controladores.
1. Baixe e instale o driver ViGEmBus.
2. Certifique-se de ter o Python 3 e o Node 18 ou mais recente instalados.

Terminal 1 para o driver de entrada:
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Terminal 2 para o servidor Web:
```powershell
cd Nearcade
npm install
npm run electron
```

## Configuração do ambiente
Para evitar a codificação de tokens confidenciais, o Nearsec depende de um arquivo de ambiente localizado em seu diretório raiz.

Crie um arquivo chamado .env e preencha-o com suas chaves específicas.
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## Endpoints internos da API Express
O servidor Nearsec Node expõe endpoints HTTP POST locais para controlar o back-end dinamicamente.

Roteamento de áudio via /api/force-route
* Carga útil: { "nodeProperty": "target_node_id" }
* Ação: Força o PipeWire a vincular dinamicamente o nó de destino específico ao coletor NearsecVirtualCapture.

Gerenciamento de processos via /api/restart-game
* Ação: Reinicia a sequência de captura.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
