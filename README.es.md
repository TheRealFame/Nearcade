<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><img src="https://img.icons8.com/?size=100&id=M725CLW4L7wE&format=png&color=000000" width="28" height="28" style="vertical-align:middle;"></a></h1>

[Inglés](README.md)\|[Español](README.es.md)\|[Francés](README.fr.md)\|[Alemán](README.de.md)\|[portugués](README.pt.md)\|[japonés](README.ja.md)

## Capturas de pantalla: Panel de control, Página del visor, Arcade

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## Misión del proyecto

Nearcade es una plataforma de código abierto que te permite jugar juegos cooperativos locales a través de Internet con amigos. Está diseñado para configuraciones autohospedadas. Utiliza conexiones de igual a igual y enrutamiento de entrada y audio del sistema operativo nativo para mantener bajo el retardo de entrada.

El foco principal son las configuraciones privadas. La aplicación host no requiere ninguna configuración de red especial. Los espectadores se unen a través de un navegador web estándar en dispositivos móviles o de escritorio. La interfaz del visor móvil incluye controles táctiles y un joystick virtual. Los usuarios no necesitan descargar nada para jugar.

## Requisitos del sistema

Necesita un software específico instalado en su máquina para ejecutar la aplicación host.

### Software requerido

-   Node.js versión 18 o posterior.
-   Python 3 para el puente de virtualización del controlador.
-   Git para descargar el código fuente.

### Requisitos de Linux

-   PipeWire debe ser su servidor de audio activo. La aplicación apunta directamente a los nodos PipeWire para separar el audio del juego de los chats de voz. No funcionará con PulseAudio.
-   Su kernel debe tener habilitado el módulo uinput para que la aplicación pueda crear gamepads virtuales nativos.
-   El sistema implementa reglas nativas de udev para bloquear los indicadores de confusión del mouse y el teclado. Esto evita los límites normales de entrada de vapor. El script de configuración proporcionado se encarga de este paso.

### Requisitos de Windows

-   Debe instalar el controlador ViGEmBus manualmente para habilitar la compatibilidad con gamepad en Windows.

### Dependencias agrupadas

La aplicación incluye binarios de Cloudflared y Zrok para crear túneles y los ejecuta de forma nativa. No es necesario instalarlos manualmente. El enrutamiento de la red se basa en un enrutador Rust VPS externo para la señalización, mientras que la transmisión de medios se realiza principalmente a través de canalizaciones WebCodecs o WebRTC de latencia ultrabaja.

## Matriz de soporte de plataforma

| Característica                                 | linux      | ventanas     | macos        |
| ---------------------------------------------- | ---------- | ------------ | ------------ |
| Transmisión de plataforma (WebCodecs / WebRTC) | Lleno      | Lleno        | Lleno        |
| Soporte para mandos                            | Lleno      | Condicional  | Ninguno      |
| Entrada de teclado y mouse                     | Lleno      | Limitado     | Lleno        |
| Controlador múltiple                           | Lleno      | Limitado     | Ninguno      |
| Reproducción de audio                          | Lleno      | Lleno        | Lleno        |
| Nivel de estabilidad                           | Producción | Experimental | Experimental |

## Instalación y documentación

La mayoría de los usuarios ejecutarán el archivo ejecutable compilado directamente. La aplicación maneja la configuración del sistema automáticamente al iniciarse.

Solo necesita ejecutar el script de configuración manualmente si está utilizando el código fuente o si la aplicación compilada no puede configurar su sistema. Para ejecutar el script de instalación de Linux manualmente, navegue hasta la carpeta bin desde la raíz del proyecto.

```bash
cd bin
sudo ./linux_setup.sh
```

Mantenemos todas las instrucciones de configuración técnica, listas de dependencias y guías de API en un directorio de documentación dedicado. Esto mantiene limpia la página principal. Puede leer estos archivos desde el ícono del libro Host Dashboard o haciendo clic en los enlaces a continuación.

-   [Guía de introducción](src/docs/GETTING_STARTED.md)
-   [Manual de uso del host](src/docs/HOST_USAGE.md)
-   [API y guía de configuración](src/docs/API_AND_SETUP.md)
-   [Configuración del servidor VPS](src/docs/VPS_SETUP.md)
-   [Documentación de lógica avanzada](src/docs/ADVANCED_LOGIC.md)
-   [Información sobre la sala de juegos Nearcade](src/docs/NEARCADE_ARCADE.md)

## Arcade cercano

La plataforma incluye un sistema de lobby público opcional. Los anfitriones pueden incluir sus sesiones en la cuadrícula Arcade para permitir que los jugadores globales descubran y se unan a juegos cooperativos locales. Puede ver el lobby público en<https://nearcade.cutefame.net>y únete a sesiones activas directamente desde tu navegador.

## Script de usuario del navegador (persistencia de identidad)

Su nombre para mostrar y el color del chat solo se guardan por sitio de forma predeterminada. El script de usuario de persistencia de identidad se ha migrado al[AbrirReproducciónRemota](https://github.com/TheRealFame/OpenRemotePlay)repositorio para actuar como un administrador de identidad universal para cualquier plataforma que utilice el protocolo OpenRemotePlay.

Instale este script de usuario universal con[Mono manipulador](https://www.tampermonkey.net/)o cualquier bifurcación y su identidad lo seguirá sin problemas en todas las sesiones de Nearcade: túneles de Cloudflare, zrok, localhost, en cualquier lugar.

[Instalar OpenRemotePlay Identidad persistente](https://github.com/TheRealFame/OpenRemotePlay/raw/main/openremoteplay-identity-persist.user.js)

## Protocolo abierto de reproducción remota (ORP)

La capa de conexión peer-to-peer de Nearcade es la base para[Abrir juego remoto](https://github.com/TheRealFame/OpenRemotePlay), una especificación de protocolo abierto con licencia del MIT para la interoperabilidad de juego remoto entre clientes y hosts desarrollados de forma independiente. El script de usuario de persistencia de identidad anterior ya se ejecuta en el protocolo ORP en la actualidad.

La especificación v2 más amplia (señalización sin servidor, un presupuesto de conexión definido de menos de 2 segundos, recorrido NAT solo STUN con un nivel de reintento forzado y un modelo de confianza construido en torno a la posesión de PIN en lugar de cualquier secreto estático compartido) es actualmente un borrador, que aún no se ha adoptado en el propio código de conexión de Nearcade. Señalización existente de Nearcade (Trystero sobre rastreadores BitTorrent, ver[Documentación de lógica avanzada](src/docs/ADVANCED_LOGIC.md)) es una de las dos estrategias de señalización que formaliza la especificación v2; La estrategia de carreras primaria de Nostr y el resto de la v2 aún no se han implementado en este repositorio. Ver el[especificación redox](https://github.com/TheRealFame/OpenRemotePlay/blob/main/spec/ORP_SPEC.md)para lo que está cubierto y lo que aún está abierto.

ORP no está vinculado al canal WebCodecs/WebRTC específico de Nearcade. Cualquier proyecto puede utilizar la capa de conexión y señalización de ORP con su propio canal de medios, y el[repositorio de ORP](https://github.com/TheRealFame/OpenRemotePlay#using-orp-with-your-own-pipeline)documenta cómo, incluso cuando una solicitud de extracción contra el protocolo en sí es el camino correcto para una canalización que necesita algo que la especificación actual aún no proporciona.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.
