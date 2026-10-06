<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><img src="https://img.icons8.com/?size=100&id=M725CLW4L7wE&format=png&color=000000" width="28" height="28" style="vertical-align:middle;"></a></h1>

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

O aplicativo agrupa binários Cloudflared e Zrok para tunelamento e os executa nativamente. Você não precisa instalá-los manualmente. O roteamento de rede depende de um roteador Rust VPS externo para sinalização, enquanto o streaming de mídia ocorre principalmente em pipelines WebCodecs de latência ultrabaixa ou WebRTC.

## Matriz de suporte da plataforma

| Recurso                                    | Linux    | Windows      | macOS        |
| ------------------------------------------ | -------- | ------------ | ------------ |
| Streaming de plataforma (WebCodecs/WebRTC) | Completo | Completo     | Completo     |
| Suporte para gamepad                       | Completo | Condicional  | Nenhum       |
| Entrada de teclado e mouse                 | Completo | Limitado     | Completo     |
| Multicontrolador                           | Completo | Limitado     | Nenhum       |
| Reprodução de áudio                        | Completo | Completo     | Completo     |
| Nível de estabilidade                      | Produção | Experimental | Experimental |

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

## Userscript do navegador (persistência de identidade)

Seu nome de exibição e cor do bate-papo são salvos apenas por site por padrão. O script de usuário de persistência de identidade foi migrado para o[AbrirRemotePlay](https://github.com/TheRealFame/OpenRemotePlay)repositório para atuar como um gerenciador de identidade universal para qualquer plataforma usando o protocolo OpenRemotePlay.

Instale este userscript universal com[Macaco Tamper](https://www.tampermonkey.net/)ou qualquer bifurcação e sua identidade o seguirá perfeitamente em todas as sessões do Nearcade — túneis Cloudflare, zrok, localhost, em qualquer lugar.

[Instalar Persistência de Identidade OpenRemotePlay](https://github.com/TheRealFame/OpenRemotePlay/raw/main/openremoteplay-identity-persist.user.js)

## Abra o protocolo de reprodução remota (ORP)

A camada de conexão ponto a ponto do Nearcade é a base para[Abra o jogo remoto](https://github.com/TheRealFame/OpenRemotePlay), uma especificação de protocolo aberta licenciada pelo MIT para interoperabilidade de reprodução remota entre clientes e hosts desenvolvidos de forma independente. O script de usuário de persistência de identidade acima já é executado no protocolo ORP hoje.

A especificação v2 mais ampla - sinalização sem servidor, um orçamento de conexão definido em menos de 2 segundos, passagem NAT somente STUN com um nível de repetição de perfuração forçada e um modelo de confiança construído em torno da posse de PIN em vez de qualquer segredo compartilhado estático - é atualmente um rascunho, ainda não adotado no próprio código de conexão do Nearcade. Sinalização existente do Nearcade (rastreadores Trystero sobre BitTorrent, consulte[Documentação lógica avançada](src/docs/ADVANCED_LOGIC.md)) é uma das duas estratégias de sinalização que a especificação v2 formaliza; a estratégia de corrida primária Nostr e o restante da v2 ainda não foram implementados neste repositório. Veja o[Especificação ORP](https://github.com/TheRealFame/OpenRemotePlay/blob/main/spec/ORP_SPEC.md)para o que está coberto e o que ainda está aberto.

ORP não está vinculado ao pipeline WebCodecs/WebRTC específico do Nearcade. Qualquer projeto pode usar a camada de conexão e sinalização do ORP com seu próprio pipeline de mídia, e o[Repositório ORP](https://github.com/TheRealFame/OpenRemotePlay#using-orp-with-your-own-pipeline)documenta como, inclusive quando uma solicitação pull contra o próprio protocolo é o caminho certo para um pipeline que precisa de algo que a especificação atual ainda não fornece.

Este projeto utiliza modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
