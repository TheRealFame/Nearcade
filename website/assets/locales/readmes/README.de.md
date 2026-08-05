<p align="left">
  <img src="assets/NearcadeLogo.png" width="160" height="140">
<h1>Nearcade</h1>

[Englisch](README.md)\|[Spanisch](assets/locales/readmes/README.es.md)\|[Französisch](assets/locales/readmes/README.fr.md)\|[Deutsch](assets/locales/readmes/README.de.md)\|[Portugiesisch](assets/locales/readmes/README.pt.md)\|[japanisch](assets/locales/readmes/README.ja.md)

## Screenshots – Dashboard, Viewer-Seite, Arcade

<div align="center">
  <img src="assets/screenshots/nearsec-client-home.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-host.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-viewer.png" alt="Nearsec Viewer" width="45%">
  <img src="assets/screenshots/nearsec-arcade.png" alt="Nearsec Arcade" width="45%">
</div>

## Projektbeschreibung

Nearcade ist eine Open-Source-Plattform mit geringer Latenz, die es Ihnen ermöglicht, mit Ihren Freunden lokale Koop-Spiele über das Internet zu spielen. Durch die Nutzung von WebRTC für UDP-First-Streaming und integrierten Browser-Hardware-Encodern bietet Nearcade eine nahezu nicht wahrnehmbare Latenz, die mit kommerziellen Cloud-Gaming-Plattformen mithalten kann – speziell zugeschnitten auf selbst gehostete Instanzen.

Im Gegensatz zu herkömmlichen Cloud-Gaming-Lösungen, die auf riesigen Rechenzentrumsleitungen und benutzerdefinierten QUIC/VP9-Hardware-Encodern basieren, ist Nearcade für den eleganten Betrieb über eine Standard-Internetverbindung zu Hause optimiert.

## Technologie-Stack

-   **Der Transport**: WebRTC verarbeitet Jitter-Puffer und NAT-Traversal automatisch.
-   **Der Vertriebspartner**: Um eine Überlastung der Upload-Bandbreite Ihres Heimnetzwerks beim Streaming an mehrere Personen zu verhindern, können Sie diese mit einer SFU (Selective Forwarding Unit) koppeln oder die integrierten Port-Weiterleitungs- und Tunneling-Optionen verwenden.
-   **Der Encoder**: Die Software greift über die WebRTC-API auf die Hardware-Kodierung Ihres Systems (NVENC, VAAPI) zu, um optimierte H.264- oder VP8/VP9-Streams basierend auf Ihrer Verbindungsqualität bereitzustellen.

* * *

## Plattformunterstützung

| Besonderheit              |      Linux     |      Windows     |       macOS      |
| ------------------------- | :------------: | :--------------: | :--------------: |
| **WebRTC-Streaming**      |               |                 |                 |
| **Gamepad-Unterstützung** |      Voll     |    ⚠ Bedingt¹   |       Keine     |
| **Tastatur-/Mauseingabe** |      Voll     |    ⚠ Begrenzt   |       Voll      |
| **Bewegungssteuerung**    |               |                 |                 |
| **Multi-Controller**      |               |    ⚠ Begrenzt   |                 |
| **Audiowiedergabe**       |               |                 |                 |
| **Erfassung anzeigen**    |               |                 |                 |
| **Stabilität**            | **Produktion** | **Experimental** | **Experimental** |

¹ Windows-Gamepad erforderlich[ViGEmBus-Treiber](https://github.com/nefarius/ViGEmBus/releases)

**[→ Detaillierte Plattform-Setup-Anleitung](PLATFORM_SETUP.md)**— Schritt-für-Schritt-Anleitungen, Fehlerbehebung und Problemumgehungen für jede Plattform.

* * *

## Erste Schritte

### Was`./start`erfolgt automatisch

-   Läuft`npm install`Wenn`node_modules`fehlt – einschließlich Electron.
-   Lädt die`uinput`Kernel-Modul unter Linux (via`sudo modprobe uinput`).
-   Fällt wieder auf kopflos zurück`node server.js`Modus, wenn Electron nicht installiert ist.

### Was Sie selbst einrichten müssen

| Abhängigkeit                 | Erforderlich für                  | Installieren                                 |
| ---------------------------- | --------------------------------- | -------------------------------------------- |
| **Node.js**(v18+)            | Alles                             | [nodejs.org](https://nodejs.org)oder`nvm`    |
| **Python 3**+`python-uinput` | Controller-Eingabevirtualisierung | `sudo ./linux_setup.sh`(Nur Linux, einmalig) |
| **uinput-Kernelmodul**       | Controller-Eingabevirtualisierung | Im Lieferumfang enthalten`linux_setup.sh`    |

> **Ohne das Python-Setup funktionieren Controller nicht.**Die App lässt sich weiterhin starten und problemlos streamen – Zuschauer können lediglich keine Gamepad- oder Tastatureingaben an den Host senden. Laufen`sudo ./linux_setup.sh`einmal nach dem Klonen, um es zu aktivieren.

> **Für Windows/macOS-Setup**, sehen[PLATFORM_SETUP.md](PLATFORM_SETUP.md)Detaillierte Anweisungen, Anforderungen und bekannte Einschränkungen für jede Plattform finden Sie hier.

### Schritt für Schritt

**Linux (empfohlen – vollständig unterstützt)**

```bash
# 1. One-time system setup (installs python-uinput, udev rules, uinput)
sudo ./linux_setup.sh

# 2. Every subsequent launch
./start
```

**Windows / macOS**_(experimentell – siehe[PLATFORM_SETUP.md](PLATFORM_SETUP.md))_

```bash
# For detailed setup instructions, troubleshooting, and known limitations:
# → Read: PLATFORM_SETUP.md

./start
```

Node.js muss bereits installiert sein. Das Skript wird mit beendet`Node.js missing`wenn es nicht gefunden wird.

### Mit Freunden teilen

1.  Klicken**Beginnen Sie mit dem Teilen**in der Host-Schnittstelle, um mit der Erfassung zu beginnen.
2.  Wählen Sie einen Tunnelanbieter (Cloudflared empfohlen – kostenlos, kein Konto erforderlich) oder richten Sie die Portweiterleitung auf TCP 3000 ein.
3.  Teilen Sie den bereitgestellten Link und die PIN mit Ihren Freunden. Das ist es.

* * *

## Sicherheit

-   **Begrenzung der PIN-Rate**– Der WebSocket-Server sperrt IPs nach wiederholten fehlgeschlagenen PIN-Versuchen.
-   **Versionsparitätsprüfungen**— Zuschauer werden sofort gewarnt, wenn ihre Client-Version von der des Hosts abweicht.
-   **Eingangsisolation**– Strenge Zugriffsrechte pro Betrachter verhindern, dass Clients unbefugte Tastatureingaben senden oder Gamepad-Slots überschreiben, die ihnen nicht gehören.

* * *

## Fehlerbehebung

### Controller funktionieren nicht

Laufen`sudo ./linux_setup.sh`falls Sie es noch nicht getan haben. Überprüfen Sie das`/dev/uinput`existiert und ist beschreibbar. Das Terminal protokolliert`[uinput] sidecar started`auf einen erfolgreichen Start.

### Kein Ton im Stream

Bei Wayland/PipeWire erfolgt die Audioaufnahme über den Bildschirmfreigabe-Portaldialog. Stellen Sie sicher, dass das Freigabedialogfeld angezeigt wird**„Audio teilen“**ist angekreuzt. Wenn nach der Freigabe immer noch kein Audio angezeigt wird, versucht die App automatisch einen PipeWire-Loopback-Fallback und protokolliert das Ergebnis.

### WebRTC-Handshake schlägt fehl / GPU-Fehler

Wenn Sie sehen`vulkan_swap_chain.cc Swapchain is suboptimal`oder ähnliche GPU-Abstürze im Terminal, Ihre Grafiktreiber lehnen die Hardwarebeschleunigungsflags von Electron ab.

1.  Offen`electron-main.js`.
2.  Finden Sie die`app.commandLine.appendSwitch('enable-features', ...)`Block.
3.  Entfernen Sie die Flags einzeln (z. B.`VaapiVideoEncoder`,`VaapiVideoDecoder`), bis sich der Strom stabilisiert.
4.  Wenn Sie sie entfernen mussten, greift die App auf die Softwarekodierung (VP8/VP9) zurück – höhere CPU-Auslastung, aber stabil.

### Electron von Grund auf neu aufbauen

Wenn`npm install`kann nicht die richtige Electron-Binärdatei für Ihre Architektur abrufen:

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

Bei ungewöhnlichen Architekturen müssen Sie Electron möglicherweise aus der Quelle erstellen`electron/build-tools`, aber das wird sehr selten benötigt.

* * *

## Aktueller Fortschritt

-   Core-Host-Benutzeroberfläche mit integrierten WebRTC-Erfassungssteuerelementen.
-   Portweiterleitung, Cloudflared und automatische Tunneling-Integration.
-   Controller-Eingangsvirtualisierung über`uinput`für eine nahtlose Umgehung des Dampfeingangs.
-   Dynamische Bitratenskalierung mit vom Benutzer wählbarer Verschlechterungspräferenz.
-   Mobile Touch-Benutzeroberfläche mit virtuellem Joystick und optionalem Gyro-Zielen.
-   Arcade-Modus – Listen Sie Ihre Sitzung öffentlich auf Nearsec Arcade auf, damit andere sie entdecken und daran teilnehmen können.

* * *

_Dieses Projekt verwendete LLMs zur Codegenerierung._
