# Solução de problemas e recuperação de falhas

Este guia cobre os cenários mais comuns de travamentos, travamentos e "simplesmente parou de funcionar" relatados no Nearcade, e as etapas exatas para se recuperar de cada um deles. Ele foi escrito para hosts e usuários avançados – não é necessário conhecimento de código.

## Índice
1. [O visualizador vê uma tela preta](#1-o visualizador vê uma tela preta)
2. [A imagem do stream piora lentamente com o tempo](#2-a imagem do stream piora lentamente com o tempo)
3. [A sessão nunca conecta (travada em "Conectando")](#3-sessão-nunca-conecta-presa-na-conexão)
4. [Controlador virtual não detectado pelo jogo](#4-controlador virtual não detectado pelo jogo)
5. [Zumbido de áudio ensurdecedor após o desligamento do host (Linux)](#5-zumbido de áudio ensurdecedor-após-o-host-desligar-linux)
6. [O chat de voz ecoa ou retroalimenta](#6-chat-de-voz-ecoa-ou-feeds-back)
7. [O navegador/sessão trava em uma conexão muito fraca](#7-a captura do navegador falha em uma rede muito fraca)
8. [Roster mostra jogadores fantasmas/duplicados](#8-roster-mostra-jogadores fantasmas ou duplicados)
9. [Um visualizador saiu, mas seus controles permaneceram conectados](#9-um-visualizador-esquerdo-mas-seus-controles-permanecem conectados)
10. [Tela de erro permanente não tratada após uma mudança de hardware](#10-tela de erro permanente não tratada após uma mudança de hardware)

---

### 1. O visualizador vê uma tela preta

**Sintoma:** O visualizador se conecta bem (a lista mostra-os, o áudio pode até funcionar), mas o vídeo fica permanentemente preto.

**Por que isso acontece:** O decodificador WebCodecs nunca recebeu sua configuração de codec. Esta é uma corrida conhecida: quando a rede host faz backup, o host descarta intencionalmente dados não críticos para manter o fluxo ativo - mas **nunca** deve descartar o pacote de configuração JSON que inicializa o `VideoDecoder` do visualizador. Se esse pacote for perdido, o decodificador nunca poderá ser inicializado e permanecerá preto para sempre, mesmo após a recuperação da rede.

**Consertar:**
1. Faça com que o visualizador atualize a página (F5) — não espere apenas.
2. Se isso ainda acontecer repetidamente, reduza a taxa de bits/resolução do host em um nível e reconecte; menor estresse = menos quedas forçadas.
3. Confirme com o host se o upload da Internet não está saturado (a pílula verde "Live" é adequada; uma amarela/vermelha significa que o codificador está fazendo backup).

---

### 2. A latência do stream piora lentamente com o tempo

**Sintoma:** O jogo funciona bem no início, mas depois de 10 a 20 minutos a visualização ao vivo fica cada vez mais atrasada e nunca se recupera sozinha.

**Por que isso acontece:** Canais de dados WebRTC e buffer WebSockets **infinitamente**. Se nada impor uma queda, o codificador enfileira lentamente os quadros obsoletos e a latência se torna permanente. O Nearcade impõe isso com verificações `bufferedAmount` que eliminam quadros obsoletos e forçam um quadro-chave – mas se uma sessão mais antiga (ou uma sessão iniciada antes da compilação atual) estiver em execução, essa proteção pode não ser aplicada.

**Consertar:**
1. Primeiro: pare e reinicie a sessão (elimina o buffer obsoleto).
2. Se continuar crescendo, atualize o cliente host para uma compilação atual.
3. Evite executar o host em Wi-Fi que compartilha a mesma conexão de downloads pesados.

---

### 3. A sessão VIP nunca conecta os controles (trava na conexão)

**Sintoma:** O vídeo funciona, mas nenhum botão/controlador responde — ou a sessão inteira fica em "Conectando…" por mais de 15s.

**Por que isso acontece:** WebRTC precisa de candidatos STUN/TURN. Se a sua rede alternar entre perfis digitados (por exemplo, um relé TURN público morto ou lento estiver no pool), o handshake poderá parar por muitos segundos enquanto determinados servidores atingem o tempo limite. A escada deve tentar primeiro servidores rápidos e confiáveis ​​e, em seguida, retransmissões da comunidade como último recurso.

**Consertar:**
1. Aguarde cerca de 25 segundos — a escada eventualmente falha e se conecta.
2. Se for uma tela de "Conexão" difícil por alguns minutos, atualize o URL do visualizador (ou reabra o link sem um `/` final).
3. Para o host: adicione seu próprio servidor TURN confiável em Configurações → Servidores TURN da comunidade. Uma retransmissão personalizada responsiva torna os handshakes quase instantâneos.

---

### 4. Controlador virtual nunca criado pelo seu jogo

**Sintoma:** O visualizador entrou no modo Gamepad, mas nenhum controlador aparece no jogo.

**Por que isso acontece:** O controlador virtual é criado por um driver do lado do kernel, que precisa de privilégios concedidos no momento da instalação no Linux ou do driver ViGEmBus de terceiros no Windows.

**Consertar:**
- **Windows:** Instale o ViGEmBus (o assistente de configuração solicita isso). Verifique se o driver existe em Gerenciador de Dispositivos → Dispositivos de Software → *ViGEm Bus Enumerator*.
- **Linux:** O host precisa de acesso de gravação a `/dev/uinput`. Verifique seu script de configuração - execute `bin/linux_setup.sh` (ou `sudo modprobe uinput`) e reinicie o host.
- Se o wingamepad estava *funcionando antes* e depois parou, certifique-se de que o aplicativo host não tenha sido atualizado no meio da condução - os manipuladores de entrada devem estar em execução com a mesma versão da UI da web. Reinicie totalmente o aplicativo host.

---

### 5. Zumbido de áudio ensurdecedor após o desligamento do host (Linux)

**Sintoma:** depois que o anfitrião sai, os alto-falantes emitem um zumbido alto e permanente que não para.

**Por que isso acontece:** O mecanismo de áudio virtual do Linux é desmontado em uma ordem específica — o módulo de loopback deve ser descarregado **antes** do coletor nulo. A ordem invertida deixa um fio de loopback apontando para um coletor morto, produzindo um zumbido até que o PulseAudio seja encerrado.

**Correção (imediata):**
```bash
pactl list short modules   # note the module IDs
pactl unload-module <loopback_module_id>   # unload ringback FIRST
pactl unload-module <null_sink_module_id>  # then the sink
```
Se não parar, reinicie o daemon de áudio:
- PulseAudio: `pulseaudio -k && systemctl --user restart pulseaudio`
- PipeWire: `systemctl --user restart pipewire pipewire-pulse`

Sempre use o botão normal "Parar sessão/Sair" da interface do host em vez de interromper o aplicativo no meio da sessão — o aplicativo executa essa desmontagem na ordem correta na saída limpa.

---

### 6. O bate-papo por voz ecoa ou retroalimenta

**Sintoma:** os espectadores ouvem a si mesmos ou ouvem tudo o que o desktop host reproduz.

**Por que isso acontece:** as vozes do visualizador são roteadas para o dispositivo de saída físico do host. Se eles forem roteados para o coletor de captura *virtual*, o loopback de áudio do jogo os capta e cria um eco infinito.

**Consertar:**
1. Host: o roteamento é automático — certifique-se de que a captura de "Áudio do aplicativo" esteja usando o coletor virtual dedicado (não o coletor de desktop/fone de ouvido).
2. Se um eco aparecer após alterar o dispositivo de saída de áudio do host, o host deverá retornar às configurações do dispositivo e selecionar a saída física (não o coletor virtual) para bate-papo por voz.

---

### 7. O host/captura falha em uma rede muito fraca ou uma sessão morre quando um visualizador aciona um dispositivo

**Sintoma:** A captura é interrompida, a lista congela ou o host se desconecta quando muitos espectadores entram/saem ou quando alguém ativa o processamento pesado (por exemplo, streaming + VR de uma só vez).

**Por que isso acontece:** Quedas agressivas de quadros e desmontagem de hot-swap consomem muitos recursos; em hosts fracos, isso satura e o navegador recupera um fluxo no meio do voo.

**Consertar:**
1. Reduza a resolução/taxa de bits máxima do host.
2. Use o modo "Somente entrada" ao transmitir **externamente** (Discord/OBS) — isso interrompe o processamento de vídeo para captura externa, liberando a máquina.
3. Ative/mantenha "Host Delay Equalization" ATIVADO — ele considera dinamicamente o tempo de codificação/transmissão para que as entradas permaneçam sincronizadas sob jitter.
4. Em VR: mantenha o WiVRn RGB e o som virtual fora dos mesmos segmentos de rede da sessão.

---

### 8. Lista mostra jogadores fantasmas/duplicados

**Sintoma:** Os jogadores permanecem na escalação após saírem ou aparecem duas vezes.

**Por quê:** O Roster DOM é renderizado novamente a partir de mensagens WebSocket assíncronas. Um bug clássico é anexar novos elementos após os antigos em uma marca separada, produzindo duplicatas. O código corrigido é limpo e reconstruído no mesmo bloco síncrono — se você ainda vir isso, o cliente está obsoleto.

**Consertar:**
1. Atualize o host (`Ctrl+Shift+R`).
2. Se você executar um cliente host personalizado a partir da origem, extraia a compilação mais recente.
3. Aguarde alguns segundos; o servidor elimina os visualizadores mortos por conta própria.

---

### 9. Um visualizador saiu, mas seu controlador permanece "pressionado"

**Sintoma:** Depois que alguém sai, uma tecla/botão permanece pressionado no jogo.

**Por quê:** O host deve reproduzir uma carga útil de "estado de repouso" para que os botões pressionados sejam liberados ao desconectar. Isso funciona quando a desconexão é tratada de forma limpa (o visualizador clica em Sair). Se a guia do visualizador for encerrada abruptamente, o controlador virtual poderá permanecer até que a pulsação do servidor expire.

**Consertar:**
1. Expulsar o espectador obsoleto da escalação (o caminho do chute força a liberação).
2. Se um slot permanecer preso, desative e ative o bloqueio do slot do visualizador ou reinicie a sessão — o dispositivo virtual é destruído e recriado de forma limpa.

---

### 10. Tela permanente de "Exceção não tratada" após uma alteração de hardware

**Cenário:** A sessão morreu com E99 (ou você vê um aviso de erro vermelho) e agora mesmo reiniciar a sessão não ajuda, por exemplo. depois de adicionar/remover uma GPU ou dispositivo de áudio.

**Por quê:** O aplicativo contém referências a um MediaStream/`peerConnection` morto e o `try/catch` mais próximo da mutação está faltando, portanto, a desmontagem é executada antes da limpeza.

**Consertar:**
1. Saia totalmente do aplicativo host (não apenas feche a sessão).
2. Confirme se os drivers de áudio/GPU no nível do sistema operacional estão OK (o dispositivo ainda está visível para outros aplicativos).
3. Abra novamente o host. Os ganchos de limpeza agora envolvem a desmontagem em try/catch e hard-stop/null em cada faixa - isso libera o identificador do dispositivo obsoleto.
4. Se o jogo nunca contribuiu para o stream, remova e adicione novamente a instância.

---

## Depurando-se rapidamente

- Abra o navegador DevTools (`Ctrl+Shift+I`) na página **host** → aba Console. Procure as notas `[WebRTC]` (telemetria de escada), `[PPS]` (inundação do visualizador), `[Congestion]` (motivos de taxa de bits) e `[codec]` (seleção H264/VP9 e detecção de iGPU).
- `npm test` (somente compilações de origem) valida o servidor: inicialização, áudio virtual, APIs REST e handshake WebSocket — `Verification Complete!` significa que o núcleo está íntegro.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.