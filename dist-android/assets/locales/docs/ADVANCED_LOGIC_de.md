Dieses Dokument bietet einen tiefen Einblick in die zugrunde liegenden Systeme, die Nearcade antreiben. Es richtet sich an Entwickler, Mitwirkende und Power-User, die den genauen Datenfluss von WebRTC, Linux-Audiovirtualisierung und Eingabeinjektion auf Kernel-Ebene verstehen müssen.

## Inhaltsverzeichnis
1. [Input-Injection-Architektur](#1-Input-Injection-Architektur)
2. [Audio-Virtualisierungspipeline](#2-audio-virtualisierungs-pipeline)
3. [Die WebRTC-Transportschicht](#3-the-webrtc-transport-layer)
4. [Videoaufnahme & Wayland](#4-video-aufnahme--wayland)
5. [Verbindungsstatus und Bereinigung](#5-connection-state--cleanup)

---

### 1. Input-Injection-Architektur
Nearsec basiert auf einem separaten Python-Sidecar-Prozess („input_driver.py“), um die Eingabeinjektion auf Betriebssystemebene zu verarbeiten. Der Node.js-Server empfängt WebSockets mit binären Gamepad-API-Arrays, entpackt sie in Standard-JSON-Strukturen und leitet sie über „stdin“ an Python weiter.

**Linux „uinput“-Implementierung**
Unter Linux verwenden wir das Kernelmodul „uinput“. Herkömmliche Emulatoren kombinieren häufig Maus-, Tastatur- und Gamepad-Funktionen in einem einzigen zusammengesetzten virtuellen Gerät. Dies führt zu schwerwiegenden Problemen in modernen Spiele-Engines (wie Unreal Engine 5 oder Unity), die Geräte aggressiv abfragen und häufig die Drift des Analogsticks mit einer Mausbewegung verwechseln, was zu einem Flackern der Benutzeroberfläche führt.

Um dieses Problem zu lösen, isoliert „linux_uinput.py“ Geräte strikt:
* Gamepads werden explizit als „Xbox 360“ (VID „0x045e“, PID „0x028e“) oder „DualSense“-Geräte erzeugt.
* Tastatur-/Mausereignisse werden auf völlig separaten virtuellen USB-Bussen erzeugt.
* Wenn ein Benutzer sein Eingabeprofil ändert (z. B. vom Gamepad zum emulierten KBM wechselt), ruft das Python-Skript aktiv „old_gp.destroy()“ auf, um das virtuelle USB-Kabel im Kernel physisch zu durchtrennen, bevor das neue Profil initialisiert wird. Dadurch wird ein „Controller-Flooding“ verhindert, bei dem Spiele aufgrund der Erkennung von mehr als 16 toten Controllern abstürzen.

---

### 2. Audio-Virtualisierungs-Pipeline
Um anwendungsspezifisches Audio unter Linux weiterzuleiten, ohne Desktop-Benachrichtigungen oder Discord-Voice-Chat zu erfassen, muss das PipeWire/PulseAudio-Diagramm direkt bearbeitet werden.

**Das Hybrid-Loopback-System**
Wenn der Node.js-Server startet, führt „initVirtualAudio()“ eine Kette von „pactl“-Befehlen aus:
1. **Modul-Null-Senke:** Erstellt „NearsecAppAudio“. Dies fungiert als digitales Schwarzes Loch. Es handelt sich um ein Ausgabegerät, auf das Spiele abzielen können.
2. **Modul-Neuzuordnungsquelle:** Erstellt „NearsecAppMic“. Dadurch wird der Monitor des Schwarzen Lochs einem erkennbaren Eingabegerät (einem Mikrofon) zugeordnet, das die „getUserMedia“-API des Browsers sicher erfassen kann.
3. **Modul-Loopback:** Erstellt eine unsichtbare, dauerhafte Verbindung von der „NearsecAppAudio“-Senke direkt zu den physischen Kopfhörern des Hosts.
4. **Lautstärkeregelung:** Wir führen explizit „pactl set-sink-volume NearsecAppAudio 70 %“ aus, um sicherzustellen, dass der Loopback in Kombination mit der lokalen Systemlautstärke keine Übersteuerungen oder Hörschäden verursacht.

**Auto-Routing und Blacklists**
Die Funktion „routeGameAudio()“ in „server.js“ ist mit einer Patchbay-Bibliothek verbunden, um alle aktiven Audioknoten auf dem System zu lesen. Anstatt Spiele auf die Whitelist zu setzen, wird eine intelligente Blacklist verwendet (`AUDIO_BLACKLIST = ['discord', 'teamspeak', 'telegram']`). Alle 3 Sekunden wird nach neuen Anwendungsbinärdateien gesucht, die Geräusche erzeugen. Wenn sie nicht auf der Blacklist stehen, werden ihre PipeWire-Ausgabeknoten physisch mit der „NearsecAppAudio“-Senke verknüpft.

---

### 3. Die WebRTC-Transportschicht
Nearsec ist kein herkömmlicher Streaming-Server; Es handelt sich um einen Signalisierungsserver, der direkte Peer-to-Peer-Verbindungen (P2P) orchestriert.

**ICE-Verhandlung und TURN**
Da sich die meisten Zuschauer hinter symmetrischen NAT-Routern befinden, schlagen direkte STUN-Verbindungen häufig fehl. Nearsec mildert dies, indem es OpenRelay TURN-Server-Anmeldeinformationen in die „RTCPeerConnection“-Konfiguration einfügt. Wenn ein direkter UDP-Punch-Through fehlschlägt, wird der Datenverkehr über das TURN-Relay auf den TCP-Port 443 zurückgeführt, wodurch eine Verbindungserfolgsrate von 99 % selbst in strengen Unternehmens- oder Universitätsnetzwerken gewährleistet wird.

**Bidirektionales Audio (Voice-Chat)**
Um Voice-over-IP (VoIP) zu implementieren, ohne die Upload-Bandbreite des Hosts zu beeinträchtigen, verwendet Nearsec eine „Switchboard“-Architektur.
* Zuschauer erfassen ihr lokales Mikrofon und hängen den Track an ihre ausgehende „RTCPeerConnection“ an.
* Der Host empfängt diese Titel und erzeugt versteckte „<audio autoplay>“-Tags.
* Der Moderator *überträgt* dieses Audio nicht erneut an andere Zuschauer. Stattdessen mischt der lokale Browser des Hosts die eingehenden WebRTC-Audiospuren nativ und gibt sie an die physischen Lautsprecher aus, wobei die „NearsecAppAudio“-Senke vollständig umgangen wird, um endlose Rückkopplungsschleifen zu verhindern.

---

### 4. Videoaufnahme und Wayland
Das Erfassen von Bildschirmen unter Linux ist bekanntermaßen fragmentiert. Nearsec nutzt Electrons „desktopCapturer“ in Verbindung mit modernen Chromium-Flags, um sowohl X11- als auch Wayland-Compositors reibungslos zu unterstützen.

Bei der Ausführung unter Wayland delegiert Electron die Bildschirmaufnahmeanforderung an das native XDG-Desktop-Portal („xdg-desktop-portal“). Dadurch wird ein nativer Betriebssystemdialog angezeigt, in dem der Benutzer um Erlaubnis zum Teilen eines Bildschirms oder Fensters gebeten wird.

Da dieses Portal eine menschliche Interaktion erfordert, kommt es zu einer inhärenten Verzögerung. Wenn der Host ein WebRTC-Angebot sendet, bevor das Wayland-Portal den Videotrack zurückgibt, stürzt die Verhandlungsschleife ab. Um dies zu beheben, erzwingt „viewer.js“ die „Vanilla ICE“-Erfassung – es wartet bis „e.candidate === null“, bevor es seine SDP-Antwort sendet. Dadurch wird der Handshake gerade lange genug verzögert, damit das Wayland-Portal den PipeWire-Videostream erfolgreich zuordnen und an den Sender anhängen kann.

---

### 5. Verbindungsstatus und Bereinigung
Stabilität in einer P2P-Umgebung mit mehreren Clients erfordert eine aggressive Speicherbereinigung.

**Geisterport-Abschwächung**
Wenn die Electron-App gewaltsam geschlossen wird, hinterlässt Node.js möglicherweise verwaiste „Cloudflared“-Tunnel oder blockierte TCP-Ports. Beim Start verwendet Nearsec „kill-port“, um Port 3000 zu bereinigen und sicherzustellen, dass der Express-Server sauber binden kann.

**Verwaiste virtuelle Geräte**
Ebenso bleiben „uinput“-Geräte im Verzeichnis „/dev/input/“ für immer aktiv, wenn der Python-Sidecar abrupt beendet wird. Der Node.js-Hook „cleanup()“ fängt „SIGINT“, „SIGTERM“ und Electron „window-close“-Ereignisse ab. Vor dem Beenden sendet es eine abschließende JSON-Nutzlast „{ type: 'destroy_all' }“ an den Python „stdin“, wodurch Python gezwungen wird, die Registrierung aller Controller aufzuheben. Gleichzeitig wird ein „pactl unload-module“-Befehl ausgegeben, der speziell auf die beim Start gespeicherte Ganzzahl „loopbackModuleId“ abzielt, die virtuellen Audiokabel sauber zerstört und den Linux-Audiographen in seinen Standardzustand zurückversetzt.

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.
