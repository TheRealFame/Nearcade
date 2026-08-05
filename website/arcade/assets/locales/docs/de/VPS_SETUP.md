# VPS-Setup

Wenn Sie keine Ports öffnen können (aufgrund von CGNAT oder strengen Firewalls), können Sie Ihren Nearcade-Verkehr über einen günstigen Cloud-VPS leiten.

### 1. Voraussetzungen
- Ein Cloud-VPS mit Linux (Ubuntu, Debian oder Oracle Cloud Linux)
- SSH-Zugriff auf den VPS
- Nearcade auf Ihrem lokalen Host-PC installiert

### 2. VPS-Router konfigurieren
Der Nearsec VPS-Router (Verzeichnis `/vps`) verarbeitet die WebSocket-Signalisierung und den Proxy-WebRTC-Handshake-Verkehr.
Laden Sie auf Ihrem VPS die Nearsec-Version herunter und führen Sie den Router aus:
```bash
./nearsec-router --port 8080
```

### 3. Host verbinden
Konfigurieren Sie in den Einstellungen der Nearsec-App unter **Dedicated Tunnel Provider** Ihre VPS-IP und Ihren VPS-Port.
Nach der Konfiguration werden alle P2P-Handshake-Daten vom VPS weitergeleitet, anstatt dass Zuschauer sich direkt mit Ihrem Heimnetzwerk verbinden müssen.
