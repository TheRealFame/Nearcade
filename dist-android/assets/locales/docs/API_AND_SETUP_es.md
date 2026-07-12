# API y configuración del sistema

## Inicio manual
Si está desarrollando o solucionando problemas, es posible que desee ejecutar los componentes manualmente en lugar de utilizar el ejecutable compilado. Nearsec requiere que dos procesos separados se ejecuten simultáneamente. Estos son el controlador de entrada de Python y el servidor web Node.js.

### Configuración manual en Linux
Linux requiere privilegios de root para inyectar controladores virtuales directamente en el kernel a través de uinput.

Terminal 1 para el controlador de entrada:
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Terminal 2 para el Servidor Web:
```bash
cd Nearcade
npm install
npm run electron
```

### Configuración manual en Windows
Windows requiere el controlador ViGEmBus para emular controladores.
1. Descargue e instale el controlador ViGEmBus.
2. Asegúrese de tener instalado Python 3 y Node 18 o una versión más reciente.

Terminal 1 para el controlador de entrada:
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Terminal 2 para el Servidor Web:
```powershell
cd Nearcade
npm install
npm run electron
```

## Configuración del entorno
Para evitar la codificación de tokens confidenciales, Nearsec se basa en un archivo de entorno ubicado en su directorio raíz.

Cree un archivo llamado .env y rellénelo con sus claves específicas.
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## Puntos finales internos de la API Express
El servidor Nearsec Node expone puntos finales HTTP POST locales para controlar el backend dinámicamente.

Enrutamiento de audio a través de /api/force-route
* Carga útil: { "nodeProperty": "target_node_id" }
* Acción: Fuerza a PipeWire a vincular dinámicamente el nodo de destino específico al sumidero NearsecVirtualCapture.

Gestión de procesos a través de /api/restart-game
* Acción: Reinicia la secuencia de captura.

Este proyecto utiliza modelos de lenguaje grandes de inteligencia artificial para la generación de código y la planificación de estructuras.
