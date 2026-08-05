# Introdução ao Nearsec juntos

Nearcade permite compartilhar jogos locais com amigos pela Internet usando WebRTC.

## Opções de hospedagem
Você tem duas maneiras de hospedar uma sessão.

1. Túneis privados: você pode configurar um túnel personalizado através do Cloudflare ou Zrok para criar um link permanente para seus amigos. Isso funciona melhor para grupos privados.
2. Nearsec Arcade: The Arcade é um diretório público para encontrar jogos cooperativos locais. As sessões são restritas a 80 minutos para manter o lobby ativo. Você deve usar um provedor de tunelamento verificado como Cloudflared ou Zrok para listar uma sessão. Você pode visualizar o lobby público em https://nearcade.cutefame.net/arcade e participar de jogos ativos.

## Iniciando uma sessão
Siga estas etapas para começar a hospedar.

1. Instale o Node.js versão 18 ou mais recente e o Python 3 em sua máquina.
2. A maioria dos usuários iniciará o executável compilado diretamente. O aplicativo gerencia permissões e túneis automaticamente.
3. Se você usar o código-fonte, abra seu terminal e navegue até a pasta bin para executar o script de configuração.

    ```bash
    cd bin
    sudo ./linux_setup.sh
    ```

4. O aplicativo Linux solicita permissão para carregar o módulo do kernel uinput. Esta etapa é necessária para construir controladores virtuais nativos.
5. Clique no botão Host Session para abrir o painel de captura.
6. Envie o link gerado e o PIN da sessão para seus visualizadores. O roteador Rust bloqueia todos os fluxos de vídeo e áudio até que o aplicativo host valide o PIN do visualizador.

Este projeto usa modelos de linguagem de inteligência artificial para geração de código e planejamento de estrutura.
