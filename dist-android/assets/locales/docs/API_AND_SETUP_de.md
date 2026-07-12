# API und System-Setup

## Manueller Start
Wenn Sie entwickeln oder Fehler beheben, möchten Sie die Komponenten möglicherweise manuell ausführen, anstatt die kompilierte ausführbare Datei zu verwenden. Nearsec erfordert die gleichzeitige Ausführung zweier separater Prozesse. Dies sind der Python-Eingabetreiber und der Node.js-Webserver.

### Manuelle Einrichtung unter Linux
Linux benötigt Root-Rechte, um virtuelle Controller über uinput direkt in den Kernel einzuschleusen.

Anschluss 1 für den Eingangstreiber:
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Terminal 2 für den Webserver:
```bash
cd Nearcade
npm install
npm run electron
```

### Manuelle Einrichtung unter Windows
Windows benötigt den ViGEmBus-Treiber, um Controller zu emulieren.
1. Laden Sie den ViGEmBus-Treiber herunter und installieren Sie ihn.
2. Stellen Sie sicher, dass Sie Python 3 und Node 18 oder neuer installiert haben.

Anschluss 1 für den Eingangstreiber:
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Terminal 2 für den Webserver:
```powershell
cd Nearcade
npm install
npm run electron
```

## Umgebungskonfiguration
Um die Hartcodierung sensibler Token zu verhindern, verlässt sich Nearsec auf eine Umgebungsdatei in Ihrem Stammverzeichnis.

Erstellen Sie eine Datei mit dem Namen .env und füllen Sie sie mit Ihren spezifischen Schlüsseln.
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## Interne Express-API-Endpunkte
Der Nearsec-Knotenserver stellt lokale HTTP-POST-Endpunkte zur Verfügung, um das Backend dynamisch zu steuern.

Audio-Routing über /api/force-route
* Nutzlast: { "nodeProperty": "target_node_id" }
* Aktion: Zwingt PipeWire, den spezifischen Zielknoten dynamisch mit der NearsecVirtualCapture-Senke zu verknüpfen.

Prozessmanagement über /api/restart-game
* Aktion: Startet die Aufnahmesequenz neu.

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.
