<p align="left">
  <img src="assets/NearcadeLogo.png" width="160" height="140">
<h1>Nearcade</h1>

[Inglés](README.md)\|[Español](assets/locales/readmes/README.es.md)\|[Francés](assets/locales/readmes/README.fr.md)\|[Alemán](assets/locales/readmes/README.de.md)\|[portugués](assets/locales/readmes/README.pt.md)\|[japonés](assets/locales/readmes/README.ja.md)

## Capturas de pantalla: Panel de control, Página del visor, Arcade

<div align="center">
  <img src="assets/screenshots/nearsec-client-home.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-host.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-viewer.png" alt="Nearsec Viewer" width="45%">
  <img src="assets/screenshots/nearsec-arcade.png" alt="Nearsec Arcade" width="45%">
</div>

## Descripción del proyecto

Nearcade es una plataforma de código abierto de baja latencia que te permite jugar juegos cooperativos locales a través de Internet con tus amigos. Al aprovechar WebRTC para transmisión UDP y codificadores de hardware de navegador integrados, Nearcade proporciona una latencia casi imperceptible que rivaliza con las plataformas comerciales de juegos en la nube, diseñada específicamente para instancias autohospedadas.

A diferencia de las soluciones tradicionales de juegos en la nube que dependían de enormes canales de centros de datos y codificadores de hardware QUIC/VP9 personalizados, Nearcade está optimizado para funcionar de manera elegante a través de una conexión a Internet doméstica estándar.

## Pila de tecnología

-   **El transporte**: WebRTC maneja automáticamente el buffering de jitter y el recorrido NAT.
-   **El Distribuidor**: Para evitar la sobrecarga del ancho de banda de carga de su red doméstica cuando transmite a varias personas, puede emparejarlo con una SFU (Unidad de reenvío selectivo) o usar las opciones integradas de reenvío de puertos y túnel.
-   **El codificador**: El software accede a la codificación de hardware de su sistema (NVENC, VAAPI) a través de la API WebRTC para ofrecer transmisiones H.264 o VP8/VP9 optimizadas según la calidad de su conexión.

* * *

## Soporte de plataforma

| Característica               |      linux     |     ventanas     |       macos      |
| ---------------------------- | :------------: | :--------------: | :--------------: |
| **Transmisión WebRTC**       |               |                 |                 |
| **Soporte para mandos**      |    Completo   |  ⚠ Condicional¹ |      Ninguno    |
| **Entrada de teclado/ratón** |    Completo   |    ⚠ Limitado   |     Completo    |
| **Controles de movimiento**  |               |                 |                 |
| **Controlador múltiple**     |               |    ⚠ Limitado   |                 |
| **Reproducción de audio**    |               |                 |                 |
| **Captura de pantalla**      |               |                 |                 |
| **Estabilidad**              | **Producción** | **Experimental** | **Experimental** |

¹ El gamepad de Windows requiere[Controlador ViGEmBus](https://github.com/nefarius/ViGEmBus/releases)

**[→ Guía detallada de configuración de la plataforma](PLATFORM_SETUP.md)**— Instrucciones paso a paso, solución de problemas y soluciones alternativas para cada plataforma.

* * *

## Empezando

### Qué`./start`maneja automáticamente

-   Corre`npm install`si`node_modules`Falta, incluido Electron.
-   Carga el`uinput`módulo del kernel en Linux (a través de`sudo modprobe uinput`).
-   Vuelve a quedar sin cabeza`node server.js`modo si Electron no está instalado.

### Lo que debes configurar tú mismo

| Dependencia                  | Requerido para                            | Instalar                                          |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------- |
| **Nodo.js**(v18+)            | Todo                                      | [nodejs.org](https://nodejs.org)o`nvm`            |
| **Pitón 3**+`python-uinput`  | Virtualización de entrada del controlador | `sudo ./linux_setup.sh`(Solo Linux, una sola vez) |
| **módulo del kernel uinput** | Virtualización de entrada del controlador | Incluido en`linux_setup.sh`                       |

> **Los controladores no funcionarán sin la configuración de Python.**La aplicación aún se iniciará y transmitirá correctamente; los espectadores simplemente no podrán enviar entradas de gamepad o teclado al anfitrión. Correr`sudo ./linux_setup.sh`una vez después de la clonación para habilitarla.

> **Para configuración de Windows/macOS**, ver[PLATFORM_SETUP.md](PLATFORM_SETUP.md)para obtener instrucciones detalladas, requisitos y limitaciones conocidas para cada plataforma.

### Paso a paso

**Linux (recomendado, totalmente compatible)**

```bash
# 1. One-time system setup (installs python-uinput, udev rules, uinput)
sudo ./linux_setup.sh

# 2. Every subsequent launch
./start
```

**Windows/macOS**_(experimental - ver[PLATFORM_SETUP.md](PLATFORM_SETUP.md))_

```bash
# For detailed setup instructions, troubleshooting, and known limitations:
# → Read: PLATFORM_SETUP.md

./start
```

Node.js ya debe estar instalado. El script saldrá con`Node.js missing`si no se encuentra.

### Compartir con amigos

1.  Hacer clic**Empezar a compartir**en la interfaz del host para comenzar la captura.
2.  Elija un proveedor de túnel (se recomienda Cloudflared: gratis, no se necesita cuenta) o configure el reenvío de puertos en TCP 3000.
3.  Comparte el enlace y el PIN proporcionados con tus amigos. Eso es todo.

* * *

## Seguridad

-   **Limitación de velocidad de PIN**— el servidor WebSocket bloquea las IP después de repetidos intentos fallidos de PIN.
-   **Comprobaciones de paridad de versiones**— los espectadores reciben una advertencia inmediata si la versión de su cliente difiere de la del host.
-   **Aislamiento de entrada**— Los permisos estrictos por espectador evitan que los clientes envíen entradas de teclado no autorizadas o anulen las ranuras del gamepad que no son de su propiedad.

* * *

## Solución de problemas

### Los controladores no funcionan

Correr`sudo ./linux_setup.sh`si aún no lo has hecho. comprueba eso`/dev/uinput`existe y se puede escribir. El terminal registrará`[uinput] sidecar started`en un lanzamiento exitoso.

### No hay audio en la transmisión.

En Wayland/PipeWire, la captura de audio se maneja a través del cuadro de diálogo del portal para compartir pantalla. Cuando aparezca el cuadro de diálogo para compartir, asegúrese de**"Compartir audio"**está marcado. Si el audio aún no aparece después de compartirlo, la aplicación intentará automáticamente un bucle invertido PipeWire y registrará el resultado.

### Error en el protocolo de enlace WebRTC/errores de GPU

si ves`vulkan_swap_chain.cc Swapchain is suboptimal`o fallas similares de GPU en la terminal, sus controladores de gráficos rechazan las banderas de aceleración de hardware de Electron.

1.  Abierto`electron-main.js`.
2.  Encuentra el`app.commandLine.appendSwitch('enable-features', ...)`bloquear.
3.  Elimine las banderas una por una (p. ej.`VaapiVideoEncoder`,`VaapiVideoDecoder`) hasta que la corriente se estabilice.
4.  Si tuviera que eliminarlos, la aplicación recurre a la codificación de software (VP8/VP9): mayor uso de CPU pero estable.

### Reconstruyendo Electron desde cero

Si`npm install`no logra extraer el binario de Electron correcto para su arquitectura:

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

En arquitecturas inusuales, es posible que necesites construir Electron desde la fuente a través de`electron/build-tools`, pero esto rara vez es necesario.

* * *

## Progreso actual

-   Core Host UI con controles de captura WebRTC integrados.
-   Reenvío de puertos, Cloudflared e integración de túneles automáticos.
-   Virtualización de entrada del controlador mediante`uinput`para evitar sin problemas la entrada de vapor.
-   Escalado dinámico de la tasa de bits con preferencia de degradación seleccionable por el usuario.
-   Interfaz de usuario táctil móvil con joystick virtual y giroscopio opcional.
-   Modo Arcade: publica tu sesión en Nearsec Arcade para que otros la descubran y se unan.

* * *

_Este proyecto utilizó LLM para la generación de código._
