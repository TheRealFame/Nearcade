# Configuración de VPS

Si no puede abrir puertos (debido a CGNAT o firewalls estrictos), puede enrutar su tráfico Nearcade a través de un VPS en la nube económico.

### 1. Requisitos previos
- Un VPS en la nube que ejecute Linux (Ubuntu, Debian u Oracle Cloud Linux)
- Acceso SSH al VPS
- Nearcade instalado en su PC host local

### 2. Configurar el enrutador VPS
El enrutador Nearsec VPS (directorio `/vps`) maneja la señalización WebSocket y el proxy del tráfico de protocolo de enlace WebRTC.
En su VPS, descargue la versión Nearsec y ejecute el enrutador:
```bash
./nearsec-router --port 8080
```

### 3. Conectar anfitrión
En la configuración de la aplicación Nearsec, en **Proveedor de túnel dedicado**, configure la IP y el puerto de su VPS.
Una vez configurado, todos los datos del protocolo de enlace P2P rebotarán en el VPS en lugar de requerir que los espectadores se conecten directamente a su red doméstica.
