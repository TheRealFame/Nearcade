<p align="left">
  <img src="assets/NearcadeLogo.png" width="160" height="140">
<h1>Nearcade</h1>

[Inglês](README.md)\|[Espanhol](assets/locales/readmes/README.es.md)\|[Francês](assets/locales/readmes/README.fr.md)\|[Alemão](assets/locales/readmes/README.de.md)\|[Português](assets/locales/readmes/README.pt.md)\|[japonês](assets/locales/readmes/README.ja.md)

## Capturas de tela – Painel, Página do Visualizador, Arcade

<div align="center">
  <img src="assets/screenshots/nearsec-client-home.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-host.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-viewer.png" alt="Nearsec Viewer" width="45%">
  <img src="assets/screenshots/nearsec-arcade.png" alt="Nearsec Arcade" width="45%">
</div>

## Descrição do projeto

Nearcade é uma plataforma de código aberto de baixa latência que permite que você jogue jogos cooperativos locais pela Internet com seus amigos. Ao aproveitar o WebRTC para streaming UDP primeiro e codificadores de hardware de navegador integrados, o Nearcade fornece latência quase imperceptível que rivaliza com plataformas comerciais de jogos em nuvem – adaptadas especificamente para instâncias auto-hospedadas.

Ao contrário das soluções tradicionais de jogos em nuvem que dependiam de enormes canais de data center e codificadores de hardware QUIC/VP9 personalizados, o Nearcade é otimizado para funcionar com elegância em uma conexão doméstica padrão de Internet.

## Pilha de tecnologia

-   **O Transporte**: WebRTC lida com buffer de jitter e passagem NAT automaticamente.
-   **O Distribuidor**: para evitar sobrecarregar a largura de banda de upload da sua rede doméstica ao transmitir para várias pessoas, você pode emparelhá-lo com uma SFU (unidade de encaminhamento seletivo) ou usar as opções integradas de encaminhamento de porta e tunelamento.
-   **O codificador**: O software acessa a codificação de hardware do seu sistema (NVENC, VAAPI) por meio da API WebRTC para fornecer fluxos H.264 ou VP8/VP9 otimizados com base na qualidade da sua conexão.

* * *

## Suporte de plataforma

| Recurso                      |     Linux    |      Windows     |       macOS      |
| ---------------------------- | :----------: | :--------------: | :--------------: |
| **Transmissão WebRTC**       |             |                 |                 |
| **Suporte para gamepad**     |   Completo  |  ⚠ Condicional¹ |      Nenhum     |
| **Entrada de teclado/mouse** |   Completo  |    ⚠ Limitado   |     Completo    |
| **Controles de movimento**   |             |                 |                 |
| **Multicontrolador**         |             |    ⚠ Limitado   |                 |
| **Reprodução de áudio**      |             |                 |                 |
| **Captura de exibição**      |             |                 |                 |
| **Estabilidade**             | **Produção** | **Experimental** | **Experimental** |

¹ O gamepad do Windows requer[Driver ViGEmBus](https://github.com/nefarius/ViGEmBus/releases)

**[→ Guia detalhado de configuração da plataforma](PLATFORM_SETUP.md)**— Instruções passo a passo, solução de problemas e soluções alternativas para cada plataforma.

* * *

## Começando

### O que`./start`lida automaticamente

-   Corre`npm install`se`node_modules`está faltando - incluindo Electron.
-   Carrega o`uinput`módulo do kernel no Linux (via`sudo modprobe uinput`).
-   Cai de volta para sem cabeça`node server.js`modo se o Electron não estiver instalado.

### O que você deve configurar sozinho

| Dependência                     | Obrigatório para                        | Instalar                                        |
| ------------------------------- | --------------------------------------- | ----------------------------------------------- |
| **Node.js**(v18+)               | Tudo                                    | [nodejs.org](https://nodejs.org)ou`nvm`         |
| **Pitão 3**+`python-uinput`     | Virtualização de entrada do controlador | `sudo ./linux_setup.sh`(Somente Linux, uma vez) |
| **módulo de kernel de entrada** | Virtualização de entrada do controlador | Incluído em`linux_setup.sh`                     |

> **Os controladores não funcionarão sem a configuração do Python.**O aplicativo ainda será iniciado e transmitido sem problemas – os espectadores simplesmente não conseguirão enviar entradas de gamepad ou teclado para o host. Correr`sudo ./linux_setup.sh`uma vez após a clonagem para habilitá-lo.

> **Para configuração do Windows/macOS**, ver[PLATFORM_SETUP.md](PLATFORM_SETUP.md)para obter instruções detalhadas, requisitos e limitações conhecidas para cada plataforma.

### Passo a passo

**Linux (recomendado – totalmente compatível)**

```bash
# 1. One-time system setup (installs python-uinput, udev rules, uinput)
sudo ./linux_setup.sh

# 2. Every subsequent launch
./start
```

**Windows/macOS**_(experimental - veja[PLATFORM_SETUP.md](PLATFORM_SETUP.md))_

```bash
# For detailed setup instructions, troubleshooting, and known limitations:
# → Read: PLATFORM_SETUP.md

./start
```

O Node.js já deve estar instalado. O script sairá com`Node.js missing`se não for encontrado.

### Compartilhando com amigos

1.  Clique**Comece a compartilhar**na interface do host para iniciar a captura.
2.  Escolha um provedor de túnel (cloudflared recomendado – gratuito, sem necessidade de conta) ou configure o encaminhamento de porta no TCP 3000.
3.  Compartilhe o link e o PIN fornecidos com seus amigos. É isso.

* * *

## Segurança

-   **Limitação de taxa de PIN**— o servidor WebSocket bloqueia IPs após repetidas tentativas fracassadas de PIN.
-   **Verificações de paridade de versão**— os espectadores são avisados ​​imediatamente se a versão do cliente for diferente da versão do host.
-   **Isolamento de entrada**- permissões estritas por visualizador evitam que os clientes enviem entradas de teclado não autorizadas ou substituam slots de gamepad que não possuem.

* * *

## Solução de problemas

### Controladores não funcionam

Correr`sudo ./linux_setup.sh`se você ainda não o fez. Verifique isso`/dev/uinput`existe e é gravável. O terminal registrará`[uinput] sidecar started`em um lançamento bem-sucedido.

### Não há áudio no stream

No Wayland/PipeWire, a captura de áudio é feita através da caixa de diálogo do portal de compartilhamento de tela. Quando a caixa de diálogo de compartilhamento aparecer, certifique-se**"Compartilhar áudio"**está marcado. Se o áudio ainda não aparecer após o compartilhamento, o aplicativo tentará automaticamente um fallback de loopback do PipeWire e registrará o resultado.

### Falha no handshake WebRTC/erros de GPU

Se você ver`vulkan_swap_chain.cc Swapchain is suboptimal`ou travamentos de GPU semelhantes no terminal, seus drivers gráficos estão rejeitando os sinalizadores de aceleração de hardware do Electron.

1.  Abrir`electron-main.js`.
2.  Encontre o`app.commandLine.appendSwitch('enable-features', ...)`bloquear.
3.  Remova os sinalizadores um por um (por exemplo`VaapiVideoEncoder`,`VaapiVideoDecoder`) até que o fluxo se estabilize.
4.  Se você tivesse que removê-los, o aplicativo voltaria à codificação de software (VP8/VP9) – maior uso da CPU, mas estável.

### Reconstruindo o elétron do zero

Se`npm install`falha ao extrair o binário Electron correto para sua arquitetura:

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

Em arquiteturas incomuns, você pode precisar construir o Electron a partir da fonte via`electron/build-tools`, mas isso raramente é necessário.

* * *

## Progresso Atual

-   UI principal do host com controles de captura WebRTC integrados.
-   Encaminhamento de porta, Cloudflared e integração automática de tunelamento.
-   Virtualização de entrada do controlador via`uinput`para ignorar perfeitamente a entrada do Steam.
-   Escala de taxa de bits dinâmica com preferência de degradação selecionável pelo usuário.
-   UI de toque móvel com joystick virtual e giroscópio opcional.
-   Modo Arcade – liste sua sessão publicamente no Nearsec Arcade para que outras pessoas descubram e participem.

* * *

_Este projeto utilizou LLMs para geração de código._
