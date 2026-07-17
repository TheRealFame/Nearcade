<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><img src="https://img.icons8.com/?size=100&id=M725CLW4L7wE&format=png&color=000000" width="28" height="28" style="vertical-align:middle;"></a></h1>

[Englisch](README.md)\|[Spanisch](README.es.md)\|[Französisch](README.fr.md)\|[Deutsch](README.de.md)\|[Portugiesisch](README.pt.md)\|[japanisch](README.ja.md)

## Screenshots – Dashboard, Viewer-Seite, Arcade

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## Projektmission

Nearcade ist eine Open-Source-Plattform, die es Ihnen ermöglicht, mit Freunden lokale Koop-Spiele über das Internet zu spielen. Es ist für selbst gehostete Setups konzipiert. Es nutzt Peer-to-Peer-Verbindungen und natives Audio- und Eingangsrouting des Betriebssystems, um die Eingangsverzögerung gering zu halten.

Der Schwerpunkt liegt auf privaten Setups. Die Host-App erfordert keine spezielle Netzwerkkonfiguration. Zuschauer nehmen über einen Standard-Webbrowser auf Desktop- oder Mobilgeräten teil. Die Benutzeroberfläche des mobilen Viewers umfasst Touch-Bedienelemente und einen virtuellen Joystick. Benutzer müssen zum Spielen nichts herunterladen.

## Systemanforderungen

Um die Host-Anwendung auszuführen, muss auf Ihrem Computer eine spezielle Software installiert sein.

### Erforderliche Software

-   Node.js Version 18 oder neuer.
-   Python 3 für die Controller-Virtualisierungsbrücke.
-   Git zum Herunterladen des Quellcodes.

### Linux-Anforderungen

-   PipeWire muss Ihr aktiver Audioserver sein. Die App zielt direkt auf PipeWire-Knoten ab, um Spielaudio von Sprachchats zu trennen. Es funktioniert nicht mit PulseAudio.
-   In Ihrem Kernel muss das Uinput-Modul aktiviert sein, damit die App native virtuelle Gamepads erstellen kann.
-   Das System stellt native udev-Regeln bereit, um Maus- und Tastaturverwechslungsflaggen zu blockieren. Dadurch werden die normalen Steam-Eingabebeschränkungen umgangen. Das bereitgestellte Setup-Skript übernimmt diesen Schritt.

### Windows-Anforderungen

-   Sie müssen den ViGEmBus-Treiber manuell installieren, um die Gamepad-Unterstützung unter Windows zu aktivieren.

### Gebündelte Abhängigkeiten

Die App bündelt Cloudflared- und Zrok-Binärdateien für das Tunneln und führt sie nativ aus. Sie müssen diese nicht manuell installieren. Das Netzwerkrouting basiert zur Signalisierung auf einem externen Rust VPS-Router, während das Medienstreaming über WebRTC erfolgt.

## Plattformunterstützungsmatrix

| Besonderheit              | Linux      | Windows      | macOS        |
| ------------------------- | ---------- | ------------ | ------------ |
| WebRTC-Streaming          | Voll       | Voll         | Voll         |
| Gamepad-Unterstützung     | Voll       | Bedingt      | Keiner       |
| Tastatur- und Mauseingabe | Voll       | Beschränkt   | Voll         |
| Multi-Controller          | Voll       | Beschränkt   | Keiner       |
| Audiowiedergabe           | Voll       | Voll         | Voll         |
| Stabilitätsniveau         | Produktion | Experimental | Experimental |

## Installation und Dokumentation

Die meisten Benutzer führen die kompilierte ausführbare Datei direkt aus. Die Anwendung führt die Systemeinrichtung beim Start automatisch durch.

Sie müssen das Setup-Skript nur dann manuell ausführen, wenn Sie den Quellcode verwenden oder wenn die kompilierte App Ihr ​​System nicht einrichten kann. Um das Linux-Setup-Skript manuell auszuführen, navigieren Sie im Stammverzeichnis des Projekts zum Ordner „bin“.

```bash
cd bin
sudo ./linux_setup.sh
```

Wir bewahren alle technischen Einrichtungsanweisungen, Abhängigkeitslisten und API-Anleitungen in einem speziellen Dokumentationsverzeichnis auf. Dadurch bleibt die Hauptseite sauber. Sie können diese Dateien über das Host-Dashboard-Buchsymbol oder durch Klicken auf die unten stehenden Links lesen.

-   [Leitfaden „Erste Schritte“.](src/docs/GETTING_STARTED.md)
-   [Host-Nutzungshandbuch](src/docs/HOST_USAGE.md)
-   [API- und Setup-Anleitung](src/docs/API_AND_SETUP.md)
-   [VPS-Server-Setup](src/docs/VPS_SETUP.md)
-   [Erweiterte Logikdokumentation](src/docs/ADVANCED_LOGIC.md)
-   [Informationen zu Nearcade Arcade](src/docs/NEARCADE_ARCADE.md)

## Nearcade Arcade

Die Plattform umfasst optional ein öffentliches Lobbysystem. Gastgeber können ihre Sitzungen im Arcade-Raster auflisten, damit globale Spieler lokale Koop-Spiele entdecken und daran teilnehmen können. Sie können die öffentliche Lobby unter besichtigen<https://nearcade.cutefame.net>und nehmen Sie direkt über Ihren Browser an aktiven Sitzungen teil.

## Browser-Userscript (Identitätspersistenz)

Ihr Anzeigename und Ihre Chat-Farbe werden standardmäßig nur pro Site gespeichert. Installieren Sie dieses Benutzerskript mit[Tampermonkey](https://www.tampermonkey.net/)oder jeder Fork und Ihre Identität folgt Ihnen über alle Nearcade-Sitzungen hinweg – Cloudflare-Tunnel, Zrok, Localhost, überall.

[Installieren Sie Nearcade Identity Persist](src/scripts/nearcade-identity-persist.user.js)

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.
