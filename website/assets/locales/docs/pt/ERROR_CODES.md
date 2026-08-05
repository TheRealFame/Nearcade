# Códigos de erro

Se o Nearsec encontrar um problema, ele exibirá um código de erro padronizado.

### Erros de rede
- **E10**: Falha na coleta de ICE. Seu firewall pode estar bloqueando completamente o tráfego WebRTC STUN.
- **E11**: Sinalização de WebSocket desconectado. O Host ou Tunnel pode ter ficado offline.

### Erros de entrada
- **E20**: Falha na criação do controlador virtual (Windows). Certifique-se de que o ViGEmBus esteja instalado e atualizado.
- **E21**: permissão de entrada negada (Linux). O host deve executar o Nearsec com privilégios `/dev/uinput` apropriados.

### Erros de áudio
- **E30**: Falha ao capturar o dispositivo de loopback. Certifique-se de ter desbloqueado o contexto de áudio clicando na IU.
- **E31**: Falha na lista negra de áudio do aplicativo. O backend PulseAudio/PipeWire retornou um erro.

### Em geral
- **E99**: exceção genérica não tratada. Verifique o console do desenvolvedor (`Ctrl+Shift+I`) para mais detalhes.
