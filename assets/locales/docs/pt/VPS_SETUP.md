#Configuração VPS

Se você não conseguir abrir portas (devido ao CGNAT ou firewalls rígidos), poderá rotear seu tráfego Nearcade por meio de um VPS em nuvem barato.

### 1. Pré-requisitos
- Um VPS em nuvem rodando Linux (Ubuntu, Debian ou Oracle Cloud Linux)
- Acesso SSH ao VPS
- Nearcade instalado no seu PC host local

### 2. Configurar roteador VPS
O roteador Nearsec VPS (diretório `/vps`) lida com sinalização WebSocket e proxy do tráfego de handshake WebRTC.
No seu VPS, baixe a versão Nearsec e execute o roteador:
```bash
./nearsec-router --port 8080
```

### 3. Conecte o host
Nas configurações do aplicativo Nearsec, em **Provedor de túnel dedicado**, configure seu IP e porta VPS.
Depois de configurados, todos os dados de handshake P2P serão devolvidos ao VPS em vez de exigir que os visualizadores se conectem diretamente à sua rede doméstica.
