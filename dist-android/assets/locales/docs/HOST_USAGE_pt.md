# Guia de uso do host e painel

O Host Dashboard é o seu centro de controle para gerenciar streams, visualizadores e áudio do sistema.

## Captura de vídeo e áudio
Quando você inicia uma sessão, o Nearsec se conecta às APIs nativas do sistema operacional, como Wayland, X11 ou Windows Graphics Capture.
* Roteamento de áudio para Linux: Nearsec cria automaticamente um coletor virtual NearsecVirtualCapture. O sistema usa propriedades exatas do nó PipeWire para rotear o áudio do jogo para esse coletor automaticamente. Isso mantém o áudio da sua área de trabalho pessoal e os bate-papos de voz fora do stream.
* Controle de volume: o coletor virtual atinge 70% do volume automaticamente para proteger sua audição.

## Lista de jogadores e permissões de entrada
Os espectadores aparecem na lista à medida que ingressam. Você tem controle total sobre seus modos de entrada.
* Gamepad: Cria um controlador virtual nativo.
* Teclado e mouse brutos: passagem de entrada direta.
* Teclado e mouse emulados: mapeia as entradas do teclado para um gamepad virtual. Isso ajuda quando jogos retrô ou de luta não possuem suporte nativo para teclado.
* Bloquear Slots: Clique no ícone do cadeado para evitar que espectadores aleatórios assumam o controle de um slot de jogador ativo.

## Gerenciamento de bate-papo por voz
Os espectadores podem enviar o áudio do microfone diretamente para o Host.
* Ícone de microfone vermelho: silenciado localmente. Você não os ouvirá, mas o áudio ainda chegará ao servidor.
* Ícone cinza do microfone: Forçar silenciamento. O servidor descarta totalmente seus pacotes de áudio para economizar largura de banda para todos os usuários.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
