<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 127.14 96.36" width="24" height="18" style="vertical-align:middle;fill:#5865F2;"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg></a></h1>

[Inglês](README.md)\|[Espanhol](README.es.md)\|[Francês](README.fr.md)\|[Alemão](README.de.md)\|[Português](README.pt.md)\|[japonês](README.ja.md)

## Capturas de tela – Painel, Página do Visualizador, Arcade

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## Missão do Projeto

Nearcade é uma plataforma de código aberto que permite jogar jogos cooperativos locais pela Internet com amigos. Ele foi desenvolvido para configurações auto-hospedadas. Ele usa conexões ponto a ponto e roteamento de entrada e áudio do sistema operacional nativo para manter baixo o atraso de entrada.

O foco principal são as configurações privadas. O aplicativo host não requer configuração de rede especial. Os espectadores ingressam por meio de um navegador padrão em computadores ou dispositivos móveis. A interface do visualizador móvel inclui controles de toque e um joystick virtual. Os usuários não precisam baixar nada para jogar.

## Requisitos do sistema

Você precisa de um software específico instalado em sua máquina para executar o aplicativo host.

### Software necessário

-   Node.js versão 18 ou mais recente.
-   Python 3 para a ponte de virtualização do controlador.
-   Git para baixar o código fonte.

### Requisitos Linux

-   PipeWire deve ser seu servidor de áudio ativo. O aplicativo tem como alvo os nós PipeWire diretamente para separar o áudio do jogo dos bate-papos de voz. Não funcionará com PulseAudio.
-   Seu kernel deve ter o módulo uinput habilitado para que o aplicativo possa criar gamepads virtuais nativos.
-   O sistema implementa regras nativas do udev para bloquear sinalizadores de confusão do mouse e do teclado. Isso ignora os limites normais de entrada do Steam. O script de configuração fornecido cuida desta etapa.

### Requisitos do Windows

-   Você deve instalar o driver ViGEmBus manualmente para ativar o suporte ao gamepad no Windows.

### Dependências agrupadas

O aplicativo agrupa binários Cloudflared e Zrok para tunelamento e os executa nativamente. Você não precisa instalá-los manualmente. O roteamento da rede depende de um roteador Rust VPS externo para sinalização, enquanto o streaming de mídia ocorre por meio de WebRTC.

## Matriz de suporte da plataforma

| Recurso                    | Linux    | Windows      | macOS        |
| -------------------------- | -------- | ------------ | ------------ |
| Transmissão WebRTC         | Completo | Completo     | Completo     |
| Suporte para gamepad       | Completo | Condicional  | Nenhum       |
| Entrada de teclado e mouse | Completo | Limitado     | Completo     |
| Multicontrolador           | Completo | Limitado     | Nenhum       |
| Reprodução de áudio        | Completo | Completo     | Completo     |
| Nível de estabilidade      | Produção | Experimental | Experimental |

## Instalação e Documentação

A maioria dos usuários executará o arquivo executável compilado diretamente. O aplicativo gerencia a configuração do sistema automaticamente na inicialização.

Você só precisa executar o script de configuração manualmente se estiver usando o código-fonte ou se o aplicativo compilado não conseguir configurar seu sistema. Para executar o script de configuração do Linux manualmente, navegue até a pasta bin na raiz do projeto.

```bash
cd bin
sudo ./linux_setup.sh
```

Mantemos todas as instruções técnicas de configuração, listas de dependências e guias de API em um diretório de documentação dedicado. Isso mantém a página principal limpa. Você pode ler esses arquivos no ícone do livro Host Dashboard ou clicando nos links abaixo.

-   [Guia de primeiros passos](src/docs/GETTING_STARTED.md)
-   [Manual de uso do host](src/docs/HOST_USAGE.md)
-   [API e guia de configuração](src/docs/API_AND_SETUP.md)
-   [Configuração do servidor VPS](src/docs/VPS_SETUP.md)
-   [Documentação lógica avançada](src/docs/ADVANCED_LOGIC.md)
-   [Informações sobre o Arcade Nearcade](src/docs/NEARCADE_ARCADE.md)

## Arcada Nearcade

A plataforma inclui um sistema opcional de lobby público. Os anfitriões podem listar suas sessões na grade do Arcade para permitir que jogadores globais descubram e participem de jogos cooperativos locais. Você pode ver o lobby público em<https://nearcade.cutefame.net>e participe de sessões ativas diretamente do seu navegador.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
