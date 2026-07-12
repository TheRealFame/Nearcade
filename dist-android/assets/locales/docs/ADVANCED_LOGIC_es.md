Este documento proporciona una inmersión profunda en los sistemas subyacentes que impulsan a Nearcade. Está destinado a desarrolladores, contribuyentes y usuarios avanzados que necesitan comprender el flujo de datos exacto de WebRTC, la virtualización de audio de Linux y la inyección de entrada a nivel de kernel.

## Tabla de contenido
1. [Arquitectura de inyección de entrada](#1-arquitectura-de-inyección-de-entrada)
2. [Canalización de virtualización de audio](#2-canalización-de-virtualización-de-audio)
3. [La capa de transporte WebRTC](#3-la-capa-de-transporte-webrtc)
4. [Captura de vídeo y Wayland](#4-captura de vídeo--wayland)
5. [Estado de conexión y limpieza] (#5-estado-de-conexión--limpieza)

---

### 1. Arquitectura de inyección de entrada
Nearsec se basa en un proceso paralelo de Python independiente (`input_driver.py`) para manejar la inyección de entrada a nivel del sistema operativo. El servidor Node.js recibe WebSockets que contienen matrices binarias de API de Gamepad, los descomprime en estructuras JSON estándar y los canaliza a Python a través de `stdin`.

**Implementación de Linux `uinput`**
En Linux, utilizamos el módulo del kernel `uinput`. Los emuladores tradicionales suelen combinar capacidades de mouse, teclado y gamepad en un único dispositivo virtual compuesto. Esto causa graves problemas en los motores de juegos modernos (como Unreal Engine 5 o Unity), que sondean agresivamente los dispositivos y a menudo confunden la deriva del joystick analógico con el movimiento del mouse, lo que provoca parpadeos en la interfaz de usuario.

Para resolver esto, `linux_uinput.py` aísla estrictamente los dispositivos:
* Los gamepads se generan explícitamente como dispositivos `Xbox 360` (VID `0x045e`, PID `0x028e`) o `DualSense`.
* Los eventos de teclado/ratón se generan en buses USB virtuales completamente separados.
* Cuando un usuario cambia su perfil de entrada (por ejemplo, cambiando de Gamepad a KBM emulado), el script de Python llama activamente a `old_gp.destroy()` para cortar físicamente el cable USB virtual en el kernel antes de inicializar el nuevo perfil. Esto evita la "inundación de controladores", donde los juegos fallan debido a la detección de más de 16 controladores muertos.

---

### 2. Canal de virtualización de audio
Enrutar audio específico de la aplicación en Linux sin capturar notificaciones de escritorio o chat de voz de Discord requiere manipular el gráfico PipeWire/PulseAudio directamente.

**El sistema de bucle invertido híbrido**
Cuando se inicia el servidor Node.js, `initVirtualAudio()` ejecuta una cadena de comandos `pactl`:
1. **Módulo receptor nulo:** Crea `NearsecAppAudio`. Esto actúa como un agujero negro digital. Es un dispositivo de salida al que pueden apuntar los juegos.
2. **Fuente de reasignación del módulo:** Crea `NearsecAppMic`. Esto asigna el monitor del agujero negro a un dispositivo de entrada reconocible (un micrófono) que la API `getUserMedia` del navegador puede capturar de forma segura.
3. **Bucle invertido del módulo:** Crea un cable invisible y permanente desde el receptor `NearsecAppAudio` directamente a los auriculares físicos del host.
4. **Control de volumen:** Ejecutamos explícitamente `pactl set-sink-volume NearsecAppAudio 70%` para garantizar que el loopback no cause recortes ni daños auditivos cuando se combina con el volumen del sistema local.

**Enrutamiento automático y listas negras**
La función `routeGameAudio()` en `server.js` interactúa con una biblioteca Patchbay para leer todos los nodos de audio activos en el sistema. En lugar de incluir juegos en la lista blanca, utiliza una lista negra inteligente (`AUDIO_BLACKLIST = ['discord', 'teamspeak', 'telegram']`). Cada 3 segundos, busca nuevos archivos binarios de aplicaciones que emitan sonido; si no están en la lista negra, vincula físicamente sus nodos de salida PipeWire al receptor `NearsecAppAudio`.

---

### 3. La capa de transporte WebRTC
Nearsec no es un servidor de transmisión tradicional; es un servidor de señalización que organiza conexiones directas Peer-to-Peer (P2P).

**Negociación ICE y TURN**
Debido a que la mayoría de los espectadores residen detrás de enrutadores NAT simétricos, las conexiones STUN directas fallan con frecuencia. Nearsec mitiga esto inyectando credenciales del servidor OpenRelay TURN en la configuración `RTCPeerConnection`. Si falla una conexión UDP directa, el tráfico vuelve al puerto TCP 443 a través del relé TURN, lo que garantiza una tasa de éxito de la conexión del 99 % incluso en redes corporativas o universitarias estrictas.

**Audio bidireccional (chat de voz)**
Para implementar voz sobre IP (VoIP) sin afectar el ancho de banda de carga del host, Nearsec utiliza una arquitectura de "conmutadora".
* Los espectadores capturan su micrófono local y adjuntan la pista a su `RTCPeerConnection` saliente.
* El anfitrión recibe estas pistas y genera etiquetas ocultas `<audio autoplay>`.
* El presentador *no* retransmite este audio a otros espectadores. En cambio, el navegador local del Host mezcla las pistas de audio WebRTC entrantes de forma nativa y las envía a los parlantes físicos, evitando por completo el sumidero `NearsecAppAudio` para evitar bucles de retroalimentación infinitos.

---

### 4. Captura de vídeo y Wayland
La captura de pantallas en Linux está notoriamente fragmentada. Nearsec aprovecha el `desktopCapturer` de Electron junto con los modernos indicadores de Chromium para admitir los compositores X11 y Wayland sin problemas.

Cuando se ejecuta en Wayland, Electron delega la solicitud de captura de pantalla al portal de escritorio XDG nativo (`xdg-desktop-portal`). Esto abre un cuadro de diálogo nativo del sistema operativo que solicita permiso al usuario para compartir una pantalla o ventana.

Debido a que este portal requiere interacción humana, existe un retraso inherente. Si el anfitrión envía una oferta WebRTC antes de que el portal Wayland devuelva la pista de video, el ciclo de negociación falla. Para solucionar este problema, `viewer.js` fuerza la recopilación "Vanilla ICE"; espera hasta `e.candidate === null` antes de enviar su respuesta SDP. Esto detiene artificialmente el protocolo de enlace el tiempo suficiente para que el portal Wayland asigne con éxito la transmisión de video PipeWire y la adjunte al remitente.

---

### 5. Estado de conexión y limpieza
La estabilidad en un entorno P2P multicliente requiere una recolección de basura agresiva.

**Mitigación del puerto fantasma**
Si la aplicación Electron se cierra a la fuerza, Node.js podría dejar túneles huérfanos "en la nube" o puertos TCP bloqueados. Al iniciarse, Nearsec utiliza `kill-port` para limpiar el puerto 3000, asegurando que el servidor Express pueda conectarse limpiamente.

**Dispositivos virtuales huérfanos**
De manera similar, si el sidecar de Python se elimina abruptamente, los dispositivos `uinput` permanecen activos en el directorio `/dev/input/` para siempre. El gancho `cleanup()` de Node.js atrapa los eventos `SIGINT`, `SIGTERM` y Electron `window-close`. Antes de salir, envía una carga útil JSON `{ type: 'destroy_all' }` final a la `stdin` de Python, lo que obliga a Python a cancelar el registro de todos los controladores. Simultáneamente emite un comando `pactl unload-module` dirigido específicamente al entero `loopbackModuleId` guardado durante el inicio, destruyendo limpiamente los cables de audio virtuales y restaurando el gráfico de audio de Linux a su estado predeterminado.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.
