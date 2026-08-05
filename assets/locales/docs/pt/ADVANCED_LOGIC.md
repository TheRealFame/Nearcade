Este documento fornece uma visão aprofundada dos sistemas subjacentes que alimentam o Nearcade. Ele é destinado a desenvolvedores, colaboradores e usuários avançados que precisam entender o fluxo de dados exato do WebRTC, virtualização de áudio Linux e injeção de entrada em nível de kernel.

## Índice
1. [Arquitetura de injeção de entrada](#1-arquitetura de injeção de entrada)
2. [Pipeline de virtualização de áudio](#2-pipeline de virtualização de áudio)
3. [A camada de transporte WebRTC](#3-the-webrtc-transport-layer)
4. [Captura de vídeo e Wayland](#4-captura de vídeo - wayland)
5. [Estado e limpeza da conexão](#5-estado da conexão--limpeza)

---

### 1. Arquitetura de injeção de entrada
Nearsec depende de um processo secundário Python separado (`input_driver.py`) para lidar com a injeção de entrada no nível do sistema operacional. O servidor Node.js recebe WebSockets contendo arrays binários de API do Gamepad, descompacta-os em estruturas JSON padrão e os canaliza para Python via `stdin`.

**Implementação Linux `uinput`**
No Linux, utilizamos o módulo do kernel `uinput`. Os emuladores tradicionais geralmente combinam recursos de mouse, teclado e gamepad em um único dispositivo virtual composto. Isso causa problemas graves em mecanismos de jogos modernos (como Unreal Engine 5 ou Unity), que pesquisam dispositivos agressivamente e muitas vezes confundem desvio do stick analógico com movimento do mouse, causando oscilações na interface do usuário.

Para resolver isso, `linux_uinput.py` isola estritamente os dispositivos:
* Gamepads são gerados explicitamente como dispositivos `Xbox 360` (VID `0x045e`, PID `0x028e`) ou `DualSense`.
* Os eventos de teclado/mouse são gerados em barramentos USB virtuais totalmente separados.
* Quando um usuário altera seu perfil de entrada (por exemplo, trocando de Gamepad para KBM emulado), o script Python chama ativamente `old_gp.destroy()` para cortar fisicamente o cabo USB virtual no kernel antes de inicializar o novo perfil. Isso evita a "inundação do controlador", onde os jogos travam devido à detecção de mais de 16 controladores mortos.

---

### 2. Pipeline de virtualização de áudio
O roteamento de áudio específico do aplicativo no Linux sem capturar notificações da área de trabalho ou bate-papo por voz do Discord requer a manipulação direta do gráfico PipeWire/PulseAudio.

**O sistema de loopback híbrido**
Quando o servidor Node.js inicializa, `initVirtualAudio()` executa uma cadeia de comandos `pactl`:
1. ** Coletor nulo do módulo: ** Cria `NearsecAppAudio`. Isso atua como um buraco negro digital. É um dispositivo de saída que os jogos podem atingir.
2. **Fonte de remapeamento do módulo:** Cria `NearsecAppMic`. Isso mapeia o monitor do buraco negro para um dispositivo de entrada reconhecível (um microfone) que a API `getUserMedia` do navegador pode capturar com segurança.
3. **Loopback do módulo:** Cria um fio invisível e permanente do coletor `NearsecAppAudio` diretamente para os fones de ouvido físicos do host.
4. **Controle de volume:** Executamos explicitamente `pactl set-sink-volume NearsecAppAudio 70%` para garantir que o loopback não cause cortes ou danos à audição quando combinado com o volume do sistema local.

**Roteamento automático e listas negras**
A função `routeGameAudio()` em `server.js` faz interface com uma biblioteca Patchbay para ler todos os nós de áudio ativos no sistema. Em vez de colocar jogos na lista de permissões, ele usa uma lista negra inteligente (`AUDIO_BLACKLIST = ['discord', 'teamspeak', 'telegram']`). A cada 3 segundos, ele procura novos binários de aplicativos emitindo som; se eles não estiverem na lista negra, ele vincula fisicamente seus nós de saída PipeWire ao coletor `NearsecAppAudio`.

---

### 3. A camada de transporte WebRTC
Nearsec não é um servidor de streaming tradicional; é um servidor de sinalização que orquestra conexões diretas ponto a ponto (P2P).

**Negociação ICE e TURN**
Como a maioria dos visualizadores residem atrás de roteadores NAT simétricos, as conexões STUN diretas frequentemente falham. Nearsec mitiga isso injetando credenciais do servidor OpenRelay TURN na configuração `RTCPeerConnection`. Se um punch-through UDP direto falhar, o tráfego retornará para a porta TCP 443 através do relé TURN, garantindo uma taxa de sucesso de conexão de 99%, mesmo em redes corporativas ou universitárias restritas.

**Áudio bidirecional (chat de voz)**
Para implementar Voice-over-IP (VoIP) sem prejudicar a largura de banda de upload do Host, o Nearsec usa uma arquitetura "Switchboard".
* Os espectadores capturam seu microfone local e conectam a faixa ao `RTCPeerConnection` de saída.
* O Host recebe essas faixas e gera tags ocultas `<audio autoplay>`.
* O Anfitrião *não* retransmite este áudio para outros telespectadores. Em vez disso, o navegador local do Host mistura as faixas de áudio WebRTC recebidas nativamente e as envia para os alto-falantes físicos, ignorando completamente o coletor `NearsecAppAudio` para evitar loops de feedback infinitos.

---

### 4. Captura de vídeo e Wayland
A captura de telas no Linux é notoriamente fragmentada. Nearsec aproveita o `desktopCapturer` do Electron juntamente com sinalizadores Chromium modernos para suportar compositores X11 e Wayland sem problemas.

Ao executar no Wayland, o Electron delega a solicitação de captura de tela ao XDG Desktop Portal nativo (`xdg-desktop-portal`). Isso abre uma caixa de diálogo nativa do sistema operacional solicitando permissão ao usuário para compartilhar uma tela ou janela.

Como este portal requer interação humana, existe um atraso inerente. Se o Host enviar uma oferta WebRTC antes que o portal Wayland retorne a trilha de vídeo, o ciclo de negociação falha. Para corrigir isso, `viewer.js` força a coleta do "Vanilla ICE" - ele espera até `e.candidate === null` antes de enviar sua resposta SDP. Isso interrompe artificialmente o handshake apenas o tempo suficiente para que o portal Wayland aloque com sucesso o fluxo de vídeo PipeWire e o anexe ao remetente.

---

### 5. Estado e limpeza da conexão
A estabilidade em um ambiente P2P multicliente requer uma coleta de lixo agressiva.

**Mitigação de porta fantasma**
Se o aplicativo Electron for fechado à força, o Node.js pode deixar túneis `cloudflared` órfãos ou portas TCP travadas. Na inicialização, o Nearsec usa `kill-port` para limpar a porta 3000, garantindo que o servidor Express possa se ligar de forma limpa.

**Dispositivos virtuais órfãos**
Da mesma forma, se o arquivo secundário do Python for encerrado abruptamente, os dispositivos `uinput` permanecerão ativos no diretório `/dev/input/` para sempre. O gancho `cleanup()` do Node.js captura eventos `SIGINT`, `SIGTERM` e Electron `window-close`. Antes de sair, ele envia uma carga JSON final `{ type: 'destroy_all' }` para o `stdin` do Python, forçando o Python a cancelar o registro de todos os controladores. Ele emite simultaneamente um comando `pactl unload-module` direcionado especificamente ao número inteiro `loopbackModuleId` salvo durante a inicialização, destruindo de forma limpa os cabos de áudio virtuais e restaurando o gráfico de áudio do Linux ao seu estado padrão.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
