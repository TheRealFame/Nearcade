# Guía de uso y panel de control del host

Host Dashboard es su centro de control para administrar transmisiones, espectadores y audio del sistema.

## Captura de vídeo y audio
Cuando inicia una sesión, Nearsec se conecta a las API de su sistema operativo nativo, como Wayland, X11 o Windows Graphics Capture.
* Enrutamiento de audio para Linux: Nearsec crea automáticamente un sumidero virtual NearsecVirtualCapture. El sistema utiliza propiedades exactas del nodo PipeWire para enrutar el audio del juego a este receptor automáticamente. Esto mantiene los chats de voz y audio de tu escritorio personal fuera de la transmisión.
* Control de volumen: el fregadero virtual se tapa automáticamente al 70 por ciento del volumen para proteger su audición.

## Lista de jugadores y permisos de entrada
Los espectadores aparecen en la lista a medida que se unen. Tienes control total sobre sus modos de entrada.
* Gamepad: Crea un controlador virtual nativo.
* Teclado y mouse sin formato: paso de entrada directa.
* Teclado y mouse emulados: asigna las entradas del teclado a un gamepad virtual. Esto ayuda cuando los juegos retro o de lucha carecen de compatibilidad con el teclado nativo.
* Bloquear ranuras: haz clic en el ícono del candado para evitar que espectadores aleatorios tomen el control de una ranura de jugador activo.

## Gestión de chat de voz
Los espectadores pueden enviar el audio de su micrófono directamente al anfitrión.
* Icono de micrófono rojo: silenciado localmente. No los escuchará pero su audio seguirá llegando al servidor.
* Icono de micrófono gris: forzar silenciado. El servidor descarta por completo sus paquetes de audio para ahorrar ancho de banda para todos los usuarios.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.
