# Solución de problemas y recuperación de fallos

Esta guía cubre los escenarios de fallas, congelaciones y "simplemente dejó de funcionar" más comunes reportados en Nearcade, y los pasos exactos para recuperarse de cada uno de ellos. Está escrito para hosts y usuarios avanzados; no se requieren conocimientos de código.

## Tabla de contenido
1. [El espectador ve una pantalla negra](#1-espectador-ve-una-pantalla-negra)
2. [La imagen en streaming empeora lentamente con el tiempo](#2-imagen en streaming-empeora-lentamente-con-el-tiempo)
3. [La sesión nunca se conecta (atascada en "Conectando")](#3-sesión-nunca-se-conecta-atascada-al-conectar)
4. [Controlador virtual no detectado por el juego](#4-controlador-virtual-no-detectado-por-el-juego)
5. [Zumbido de audio ensordecedor después de que el host se apaga (Linux)](#5-zumbido-de-audio-ensordecedor-después-de-apagar-el-host-linux)
6. [El chat de voz hace eco o retroalimenta](#6-voice-chat-echoes-or-feed-back)
7. [El navegador/la sesión falla en una conexión muy débil](#7-browsercapture-fails-on-a-very-weak-network)
8. [La lista muestra jugadores fantasmas/duplicados](#8-roster-shows-ghost-or-duplicate-players)
9. [Un espectador se fue pero sus controles permanecen conectados](#9-un-espectador-se fue pero-sus-controles-permanecen-conectados)
10. [Pantalla de error permanente no controlado después de un cambio de hardware](#10-pantalla-de-error-permanente-no controlado-después-de-un-cambio-de-hardware)

---

### 1. El espectador ve una pantalla negra

**Síntoma:** El espectador se conecta bien (la lista los muestra, el audio puede incluso funcionar) pero el video está permanentemente en negro.

**Por qué sucede:** Al decodificador WebCodecs nunca se le proporcionó su configuración de códec. Esta es una carrera conocida: cuando la red del host realiza una copia de seguridad, el host descarta intencionalmente datos no críticos para mantener viva la transmisión, pero **nunca** debe descartar el paquete de configuración JSON que inicia el `VideoDecoder` del espectador. Si ese paquete se pierde, el decodificador nunca podrá inicializarse y permanecerá en negro para siempre, incluso después de que la red se recupere.

**Arreglar:**
1. Haga que el espectador actualice la página (F5); no se limite a esperar.
2. Si todavía sucede repetidamente, reduzca la tasa de bits/resolución del host un nivel y vuelva a conectarse; menor estrés = menos caídas forzadas.
3. Confirme con el anfitrión que su carga de Internet no esté saturada (la pastilla verde "En vivo" está bien; una amarilla/roja significa que el codificador está retrocediendo).

---

### 2. La latencia de la transmisión empeora lentamente con el tiempo

**Síntoma:** El juego funciona bien al principio, pero después de 10 a 20 minutos la vista en vivo se retrasa cada vez más y nunca se recupera por sí sola.

**Por qué sucede:** Canales de datos WebRTC y buffer WebSockets **infinitamente**. Si nada impone una caída, el codificador pone lentamente en cola los fotogramas obsoletos y la latencia se vuelve permanente. Nearcade aplica esto con comprobaciones `bufferedAmount` que eliminan fotogramas obsoletos y fuerzan un fotograma clave, pero si se está ejecutando una sesión anterior (o una sesión iniciada antes de la compilación actual), es posible que no se aplique esa protección.

**Arreglar:**
1. Primero: detenga y reinicie la sesión (elimine el búfer obsoleto).
2. Si sigue creciendo, actualice el cliente host a una versión actual.
3. Evite ejecutar el host en Wi-Fi que comparte la misma conexión que las descargas pesadas.

---

### 3. La sesión VIP nunca conecta los controles (atascado en Conexión)

**Síntoma:** El vídeo funciona pero ningún botón/controlador responde, o toda la sesión permanece en "Conectando..." durante más de 15 segundos.

**Por qué sucede:** WebRTC necesita candidatos STUN/TURN. Si su red intercambia entre perfiles escritos (por ejemplo, hay un relé TURN público inactivo o lento en el grupo), el protocolo de enlace puede detenerse durante muchos segundos mientras ciertos servidores agotan el tiempo de espera. Se supone que la escalera debe probar primero con servidores rápidos y confiables y luego con retransmisiones comunitarias como último recurso.

**Arreglar:**
1. Espere hasta ~25 segundos; la escalera finalmente falla y se conecta.
2. Si la pantalla "Conectando" aparece durante minutos, actualice la URL del visor (o vuelva a abrir el enlace sin un `/` al final).
3. Para el anfitrión: agregue su propio servidor TURN de confianza en Configuración → Servidores TURN comunitarios. Un relé personalizado receptivo hace que los apretones de manos sean casi instantáneos.

---

### 4. Controlador virtual nunca creado por tu juego

**Síntoma:** El espectador se unió en modo Gamepad, pero no aparece ningún controlador en el juego.

**Por qué sucede:** El controlador virtual es creado por un controlador del lado del kernel, que necesita privants otorgados en el momento de la instalación en Linux o el controlador ViGEmBus de terceros en Windows.

**Arreglar:**
- **Windows:** Instale ViGEmBus (el asistente de instalación lo solicita). Verifique que el controlador exista en Administrador de dispositivos → Dispositivos de software → *ViGEm Bus Enumerator*.
- **Linux:** El host necesita acceso de escritura a `/dev/uinput`. Verifique con su script de configuración: ejecute `bin/linux_setup.sh` (o `sudo modprobe uinput`) y luego reinicie el host.
- Si el Wingamepad estaba *funcionando antes* y luego se detuvo, asegúrese de que la aplicación host no se haya actualizado en pleno funcionamiento; los controladores de entrada deben estar ejecutándose con la misma versión que la interfaz de usuario web. Reinicie la aplicación host por completo.

---

### 5. Zumbido de audio ensordecedor después de que el host se apaga (Linux)

**Síntoma:** Después de que el anfitrión cierra, los parlantes emiten un zumbido fuerte y permanente que no se detiene.

**Por qué sucede:** El motor de audio virtual de Linux se desmonta en un orden específico: el módulo de loopback debe descargarse **antes** del sumidero nulo. El orden invertido deja un cable de bucle invertido apuntando a un sumidero inactivo, lo que produce un zumbido hasta que se desactiva PulseAudio.

**Solución (inmediata):**
```bash
pactl list short modules   # note the module IDs
pactl unload-module <loopback_module_id>   # unload ringback FIRST
pactl unload-module <null_sink_module_id>  # then the sink
```
Si no se detiene, reinicie el demonio de audio:
-PulseAudio: `pulseaudio -k && systemctl --user restart pulseaudio`
- Cable de tubería: `systemctl --user restart pipewire pipewire-pulse`

Utilice siempre el botón normal "Detener sesión/Salir" de la interfaz de usuario del host en lugar de cerrar la aplicación a mitad de sesión; la aplicación realiza este desmontaje en el orden correcto al salir limpiamente.

---

### 6. El chat de voz hace eco o retroalimenta

**Síntoma:** Los espectadores se escuchan a sí mismos o escuchan todo lo que reproduce el escritorio del host.

**Por qué sucede:** Las voces de los espectadores se enrutan al dispositivo de salida físico del anfitrión. Si, en cambio, se dirigen al receptor de captura *virtual*, el bucle de audio del juego los capta y crea un eco interminable.

**Arreglar:**
1. Host: el enrutamiento es automático; asegúrese de que la captura de "Audio de la aplicación" utilice el receptor virtual dedicado (no el receptor de escritorio/auriculares).
2. Si aparece un eco después de cambiar el dispositivo de salida de audio del anfitrión, el anfitrión debe volver a la configuración del dispositivo y seleccionar la salida física (no el receptor virtual) para el chat de voz.

---

### 7. El host/captura falla en una red muy débil o una sesión muere cuando un espectador maneja un dispositivo

**Síntoma:** La captura se detiene, la lista se congela o el anfitrión se desconecta cuando muchos espectadores se unen o salen o cuando alguien habilita un procesamiento intensivo (por ejemplo, transmisión + VR a la vez).

**Por qué sucede:** Las caídas agresivas de cuadros y el desmontaje de intercambio en caliente consumen muchos recursos; en hosts débiles, esto se satura y el navegador recupera una transmisión en pleno vuelo.

**Arreglar:**
1. Reduzca la resolución/tasa de bits máxima del host.
2. Utilice el modo "Sólo entrada" cuando transmita **externamente** (Discord/OBS): esto detiene el procesamiento de video para captura externa, liberando la máquina.
3. Habilite/mantenga activada la "ecualización de retardo del host": influye dinámicamente en el tiempo de codificación/transmisión para que las entradas permanezcan sincronizadas bajo fluctuación.
4. En VR: mantenga el WiVRn RGB y el sonido virtual fuera de los mismos segmentos de red que la sesión.

---

### 8. La lista muestra jugadores fantasmas/duplicados

**Síntoma:** Los jugadores permanecen en la lista después de salir o aparecen dos veces.

**Por qué:** La lista DOM se vuelve a representar a partir de mensajes asíncronos de WebSocket. Un error clásico es agregar nuevos elementos después de los antiguos en una marca separada, lo que produce duplicados. El código fijo se borra y se reconstruye en el mismo bloque sincrónico; si aún ve esto, el cliente está obsoleto.

**Arreglar:**
1. Actualice completamente el host (`Ctrl+Shift+R`).
2. Si ejecuta un cliente de host personalizado desde el origen, obtenga la última versión.
3. Espere unos segundos; el servidor elimina a los espectadores muertos por sí solo.

---

### 9. Un espectador se fue, pero su controlador permanece "presionado"

**Síntoma:** Después de que alguien se va, una tecla/botón permanece presionado en el juego.

**Por qué:** El host debe reproducir una carga útil en "estado de reposo" para que los botones retenidos se suelten al desconectarse. Esto funciona cuando la desconexión se maneja limpiamente (el espectador hace clic en Salir). Si la pestaña del visor se cerró abruptamente, el controlador virtual podría permanecer hasta que el latido del servidor expire.

**Arreglar:**
1. Expulsar al espectador obsoleto de la lista (la ruta de expulsión fuerza la liberación).
2. Si una ranura permanece atascada, desactive y active el bloqueo de la ranura del espectador o reinicie la sesión: el dispositivo virtual se destruye y se recrea limpiamente.

---

### 10. Pantalla permanente de "Excepción no controlada" después de un cambio de hardware

**Escenario:** La sesión finalizó con E99 (o ve un mensaje de error rojo) y ahora ni siquiera reiniciar la sesión ayuda, p. después de agregar/eliminar una GPU o dispositivo de audio.

**Por qué:** La aplicación contiene referencias a un MediaStream/`peerConnection` inactivo y falta el `try/catch` más cercano para la mutación, por lo que se realiza el desmontaje antes de la limpieza.

**Arreglar:**
1. Salga completamente de la aplicación host (no solo cierre la sesión).
2. Confirme que los controladores de audio/GPU a nivel del sistema operativo estén bien (el dispositivo aún es visible para otras aplicaciones).
3. Vuelva a abrir el host. Los ganchos de limpieza ahora envuelven el desmontaje en try/catch y hard-stop/null cada pista; esto libera el control del dispositivo obsoleto.
4. Si el juego nunca contribuyó a la transmisión, elimina y vuelve a agregar la instancia.

---

## Depurándote rápidamente

- Abra el navegador DevTools (`Ctrl+Shift+I`) en la página **host** → pestaña Consola. Busque las notas `[WebRTC]` (telemetría de escalera), `[PPS]` (inundación del visor), `[Congestion]` (motivos de tasa de bits) y `[codec]` (selección H264/VP9 y detección de iGPU).
- `npm test` (solo compilaciones de origen) valida el servidor: arranque, audio virtual, API REST y protocolo de enlace WebSocket; `Verification Complete!` significa que el núcleo está en buen estado.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.