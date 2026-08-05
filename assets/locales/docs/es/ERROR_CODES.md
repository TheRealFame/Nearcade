# Códigos de error

Si Nearsec encuentra un problema, mostrará un código de error estandarizado.

### Errores de red
- **E10**: Falló la reunión ICE. Es posible que su firewall esté bloqueando completamente el tráfico WebRTC STUN.
- **E11**: Señalización WebSocket desconectada. Es posible que el host o el túnel se hayan desconectado.

### Errores de entrada
- **E20**: Error al crear el controlador virtual (Windows). Asegúrese de que ViGEmBus esté instalado y actualizado.
- **E21**: Permiso de entrada denegado (Linux). El host debe ejecutar Nearsec con los privilegios `/dev/uinput` adecuados.

### Errores de audio
- **E30**: No se pudo capturar el dispositivo de loopback. Asegúrese de haber desbloqueado el contexto de audio haciendo clic en la interfaz de usuario.
- **E31**: Error en la lista negra de audio de la aplicación. El backend de PulseAudio/PipeWire devolvió un error.

### General
- **E99**: Excepción genérica no controlada. Consulte la consola del desarrollador (`Ctrl+Shift+I`) para obtener más detalles.
