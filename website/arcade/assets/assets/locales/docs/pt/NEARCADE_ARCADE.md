# Nearcade Arcade

O Nearcade Arcade é um serviço global de matchmaking onde qualquer pessoa pode listar publicamente suas sessões ativas.

### Listando sua sessão
Ao iniciar uma sessão de host, clique no botão de alternância "Listar no Live Arcade". Sua sessão aparecerá imediatamente na aba Arcade para todos os usuários do Nearcade.

### Segurança
- **Sem vazamento direto de IP**: Se você estiver usando um túnel (zrok, cloudflared) ou um VPS, seu endereço IP residencial real será mascarado na listagem do Arcade.
- **Proteção PIN**: você ainda pode aplicar um código PIN nas sessões do Arcade. Os espectadores verão seu lobby, mas deverão saber o PIN para entrar.

### Batimentos cardíacos de arcade
O aplicativo host envia um ping de “pulsação” para o Arcade a cada 30 segundos. Se você fechar o Nearcade ou perder a conexão, sua listagem será removida automaticamente em 1 minuto.
