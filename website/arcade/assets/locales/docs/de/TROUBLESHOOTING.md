# Fehlerbehebung und Wiederherstellung nach Abstürzen

Dieser Leitfaden behandelt die häufigsten Abstürze, Einfrierungen und „Es funktioniert einfach nicht mehr“-Szenarien, die bei Nearcade gemeldet wurden, sowie die genauen Schritte zur Wiederherstellung nach jedem einzelnen Szenario. Es ist für Hosts und Power-User geschrieben – es sind keine Code-Kenntnisse erforderlich.

## Inhaltsverzeichnis
1. [Betrachter sieht einen schwarzen Bildschirm](#1-Betrachter-sieht-einen-schwarzen-Bildschirm)
2. [Stream-Bild wird mit der Zeit langsam schlechter](#2-Stream-Bild wird mit der Zeit langsam schlechter)
3. [Sitzung verbindet sich nie (hängt bei „Verbinden“)](#3-session-never-connects-stuck-on-connecting)
4. [Virtueller Controller wurde vom Spiel nicht erkannt](#4-virtual-controller-not-detected-by-game)
5. [Ohrbetäubendes Audio-Summen nach dem Herunterfahren des Hosts (Linux)](#5-deafening-audio-buzz-after-the-host-shuts-down-linux)
6. [Voice-Chat-Echos oder -Feedbacks](#6-Voice-Chat-Echos-oder-Feedbacks)
7. [Browser/Sitzung stürzt bei einer sehr schwachen Verbindung ab](#7-browsercapture-fails-on-a-very-weak-network)
8. [Dienstplan zeigt Geister-/doppelte Spieler](#8-roster-shows-ghost-or-duplicate-players)
9. [Ein Zuschauer ist gegangen, aber seine Bedienelemente bleiben angeschlossen](#9-a-viewer-left-but-their-controls-stay-plugged-in)
10. [Permanent-unbehandelter Fehlerbildschirm nach einer Hardware-Änderung](#10-permanent-unbehandelter-Fehler-Bildschirm-nach-einer-Hardware-Änderung)

---

### 1. Der Betrachter sieht einen schwarzen Bildschirm

**Symptom:** Der Viewer verbindet sich einwandfrei (der Dienstplan zeigt sie an, möglicherweise funktioniert sogar der Ton), aber das Video ist dauerhaft schwarz.

**Warum es passiert:** Der WebCodecs-Decoder erhielt nie seine Codec-Konfiguration. Dies ist ein bekannter Wettlauf: Wenn das Host-Netzwerk eine Sicherung durchführt, verwirft der Host absichtlich unkritische Daten, um den Stream am Leben zu halten – er darf jedoch **niemals** das JSON-Konfigurationspaket verwerfen, das die `VideoDecoder` des Viewers startet. Wenn dieses Paket fehlt, kann der Decoder nie initialisiert werden und bleibt für immer schwarz, selbst nachdem das Netzwerk wiederhergestellt ist.

**Fix:**
1. Bitten Sie den Betrachter, die Seite zu aktualisieren (F5) – warten Sie nicht einfach.
2. Wenn das Problem immer noch auftritt, reduzieren Sie die Bitrate/Auflösung des Hosts um eine Stufe und stellen Sie die Verbindung erneut her. geringere Belastung = weniger erzwungene Stürze.
3. Vergewissern Sie sich beim Host, dass sein Internet-Upload nicht ausgelastet ist (grüne „Live“-Anzeige ist in Ordnung; eine gelbe/rote Anzeige bedeutet, dass der Encoder eine Sicherung durchführt).

---

### 2. Die Stream-Latenz wird mit der Zeit langsam schlimmer

**Symptom:** Das Spiel läuft zunächst gut, aber nach 10–20 Minuten hinkt die Live-Ansicht immer weiter hinterher und erholt sich nie von selbst.

**Warum es passiert:** WebRTC-Datenkanäle und WebSockets puffern **unendlich**. Wenn nichts einen Abbruch erzwingt, stellt der Encoder veraltete Frames langsam in die Warteschlange und die Latenz wird dauerhaft. Nearcade erzwingt dies mit `bufferedAmount`-Prüfungen, die veraltete Frames verwerfen und einen Keyframe erzwingen – wenn jedoch eine ältere Sitzung (oder eine Sitzung, die vor dem aktuellen Build gestartet wurde) ausgeführt wird, wird dieser Schutz möglicherweise nicht angewendet.

**Fix:**
1. Erstens: Stoppen Sie die Sitzung und starten Sie sie neu (löscht den veralteten Puffer).
2. Wenn es weiter wächst, aktualisieren Sie den Host-Client auf einen aktuellen Build.
3. Vermeiden Sie es, den Host über ein WLAN zu betreiben, das dieselbe Verbindung nutzt wie umfangreiche Downloads.

---

### 3. VIP-Sitzung stellt nie eine Verbindung zu Steuerelementen her (hängt beim Verbinden fest)

**Symptom:** Video funktioniert, aber keine Tasten/Controller reagieren – oder die gesamte Sitzung bleibt 15 Sekunden lang auf „Verbinden…“ stehen.

**Warum es passiert:** WebRTC benötigt STUN/TURN-Kandidaten. Wenn Ihr Netzwerk zwischen typisierten Profilen wechselt (z. B. wenn sich ein öffentliches TURN-Relay inaktiv oder langsam im Pool befindet), kann der Handshake mehrere Sekunden lang ins Stocken geraten, während bei bestimmten Servern eine Zeitüberschreitung auftritt. Der Ladder soll zunächst schnelle, zuverlässige Server und als letzten Ausweg Community-Relays ausprobieren.

**Fix:**
1. Warten Sie bis zu ca. 25 Sekunden – die Leiter führt schließlich einen Failover durch und stellt eine Verbindung her.
2. Wenn der Bildschirm „Verbinden“ mehrere Minuten lang nicht angezeigt wird, aktualisieren Sie die Viewer-URL erneut (oder öffnen Sie den Link ohne nachgestellten `/` erneut).
3. Für den Host: Fügen Sie Ihren eigenen vertrauenswürdigen TURN-Server unter Einstellungen → Community-TURN-Server hinzu. Ein reaktionsfähiges benutzerdefiniertes Relay sorgt dafür, dass Handshakes nahezu augenblicklich erfolgen.

---

### 4. Virtueller Controller, der nie von Ihrem Spiel erstellt wurde

**Symptom:** Der Viewer ist im Gamepad-Modus beigetreten, aber im Spiel wird kein Controller angezeigt.

**Warum es passiert:** Der virtuelle Controller wird von einem Kernel-seitigen Treiber erstellt, der entweder bei der Installation unter Linux gewährte Privilegien oder unter Windows den ViGEmBus-Treiber eines Drittanbieters benötigt.

**Fix:**
- **Windows:** Installieren Sie ViGEmBus (der Setup-Assistent fordert Sie dazu auf). Überprüfen Sie, ob der Treiber unter Geräte-Manager → Softwaregeräte → *ViGEm Bus Enumerator* vorhanden ist.
- **Linux:** Der Host benötigt Schreibzugriff auf `/dev/uinput`. Überprüfen Sie es mit Ihrem Setup-Skript – führen Sie `bin/linux_setup.sh` (oder `sudo modprobe uinput`) aus und starten Sie dann den Host neu.
– Wenn das Wingamepad *vorher* funktionierte und dann gestoppt wurde, stellen Sie sicher, dass die Host-App nicht während der Fahrt aktualisiert wurde – Eingabehandler müssen mit derselben Version wie die Web-Benutzeroberfläche ausgeführt werden. Starten Sie die Host-App vollständig neu.

---

### 5. Ohrenbetäubender Ton nach dem Herunterfahren des Hosts (Linux)

**Symptom:** Nachdem der Host beendet wurde, geben die Lautsprecher ein lautes, permanentes Summen ab, das nicht aufhört.

**Warum es passiert:** Die virtuelle Linux-Audio-Engine wird in einer bestimmten Reihenfolge heruntergefahren – das Loopback-Modul muss **vor** der Nullsenke entladen werden. Bei umgekehrter Reihenfolge zeigt ein Loopback-Kabel auf eine tote Senke und erzeugt ein Summen, bis PulseAudio ausgeschaltet wird.

**Behebung (sofort):**
```bash
pactl list short modules   # note the module IDs
pactl unload-module <loopback_module_id>   # unload ringback FIRST
pactl unload-module <null_sink_module_id>  # then the sink
```
Wenn es nicht stoppt, starten Sie den Audio-Daemon neu:
- PulseAudio: `pulseaudio -k && systemctl --user restart pulseaudio`
- PipeWire: `systemctl --user restart pipewire pipewire-pulse`

Verwenden Sie immer die normale Schaltfläche „Sitzung beenden/beenden“ auf der Host-Benutzeroberfläche, anstatt die App mitten in der Sitzung zu beenden – die App führt diesen Teardown beim sauberen Beenden in der richtigen Reihenfolge durch.

---

### 6. Voice-Chat-Echos oder Rückmeldungen

**Symptom:** Zuschauer hören sich selbst oder hören alles, was der Host-Desktop abspielt.

**Warum es passiert:** Zuschauerstimmen werden an das physische Ausgabegerät des Hosts weitergeleitet. Wenn sie stattdessen an die *virtuelle* Erfassungssenke weitergeleitet werden, nimmt der Audio-Loopback des Spiels sie auf und erzeugt ein endloses Echo.

**Fix:**
1. Host: Das Routing erfolgt automatisch – stellen Sie sicher, dass die „Application Audio“-Aufnahme die dedizierte virtuelle Senke verwendet (nicht die Desktop-/Kopfhörer-Senke).
2. Wenn nach dem Wechsel des Audioausgabegeräts des Hosts ein Echo auftritt, sollte der Host zu den Geräteeinstellungen zurückkehren und den physischen Ausgang (nicht die virtuelle Senke) für den Voice-Chat auswählen.

---

### 7. Host/Erfassung schlägt in einem sehr schwachen Netzwerk fehl oder eine Sitzung wird unterbrochen, wenn ein Betrachter ein Gerät ansteuert

**Symptom:** Die Aufnahme stoppt, der Teilnehmerplan friert ein oder der Host trennt die Verbindung, wenn viele Zuschauer beitreten/gehen oder wenn jemand eine starke Verarbeitung aktiviert (z. B. Streaming + VR gleichzeitig).

**Warum es passiert:** Aggressive Frame-Drops und Hot-Swap-Teardown sind ressourcenintensiv; Auf schwachen Hosts erreicht dies die Sättigung und der Browser fordert mitten im Flug einen Stream zurück.

**Fix:**
1. Reduzieren Sie die maximale Auflösung/Bitrate des Hosts.
2. Verwenden Sie den Modus „Nur Eingabe“, wenn Sie **extern** senden (Discord/OBS) – dadurch wird die Videoverarbeitung für die externe Aufnahme gestoppt und das Gerät entlastet.
3. Aktivieren/belassen Sie „Host Delay Equalization“ auf EIN – die Codierungs-/Übertragungszeit wird dynamisch berücksichtigt, damit die Eingaben bei Jitter synchronisiert bleiben.
4. In VR: Halten Sie WiVRn RGB und den virtuellen Sound von denselben Netzwerksegmenten fern wie die Sitzung.

---

### 8. Im Kader werden Geister/doppelte Spieler angezeigt

**Symptom:** Spieler bleiben nach dem Ausscheiden im Kader oder erscheinen zweimal.

**Warum:** Roster DOM wird aus asynchronen WebSocket-Nachrichten neu gerendert. Ein klassischer Fehler ist das Anhängen neuer Elemente nach den alten in einem separaten Tick, wodurch Duplikate entstehen. Der feste Code wird im selben synchronen Block gelöscht und neu erstellt. Wenn dies immer noch angezeigt wird, ist der Client veraltet.

**Fix:**
1. Aktualisieren Sie den Host (`Ctrl+Shift+R`) hart.
2. Wenn Sie einen benutzerdefinierten Host-Client aus der Quelle ausführen, rufen Sie den neuesten Build ab.
3. Warten Sie einige Sekunden; Der Server bereinigt tote Zuschauer selbstständig.

---

### 9. Ein Zuschauer ist gegangen, aber sein Controller bleibt „gedrückt“

**Symptom:** Nachdem jemand das Spiel verlassen hat, bleibt eine Taste im Spiel gedrückt.

**Warum:** Der Host muss eine Nutzlast im „Ruhezustand“ wiedergeben, damit gedrückte Tasten beim Trennen der Verbindung freigegeben werden. Dies funktioniert, wenn die Trennung sauber gehandhabt wird (der Betrachter klickt auf „Verlassen“). Wenn die Registerkarte des Viewers abrupt beendet wurde, bleibt der virtuelle Controller möglicherweise bestehen, bis der Heartbeat des Servers ihn abläuft.

**Fix:**
1. Kicken Sie den veralteten Viewer aus dem Kader (der Kick-Pfad erzwingt die Freigabe).
2. Wenn ein Steckplatz hängen bleibt, schalten Sie die Steckplatzsperre des Viewers aus und wieder ein oder starten Sie die Sitzung neu – das virtuelle Gerät wird zerstört und sauber neu erstellt.

---

### 10. Ständiger Bildschirm „Unbehandelte Ausnahme“ nach einer Hardwareänderung

**Szenario:** Sitzung ist mit E99 abgebrochen (oder Sie sehen einen roten Fehlertoast), und jetzt hilft auch ein Neustart der Sitzung nicht, z. B. nach dem Hinzufügen/Entfernen einer GPU oder eines Audiogeräts.

**Warum:** Die App enthält Verweise auf einen toten MediaStream/`peerConnection` und der nächste `try/catch` für die Mutation fehlt, sodass Teardown vor der Bereinigung ausgelöst wird.

**Fix:**
1. Beenden Sie die Host-App vollständig (nicht nur die Sitzung schließen).
2. Bestätigen Sie, dass die Audio-/GPU-Treiber auf Betriebssystemebene in Ordnung sind (das Gerät ist weiterhin für andere Apps sichtbar).
3. Öffnen Sie den Host erneut. Cleanup-Hooks umschließen Teardown jetzt in Try/Catch und Hard-Stop/Null für jeden Track – dadurch wird das veraltete Gerätehandle freigegeben.
4. Wenn das Spiel nie zum Stream beigetragen hat, entfernen Sie die Instanz und fügen Sie sie erneut hinzu.

---

## Debuggen Sie sich schnell selbst

- Öffnen Sie den Browser DevTools (`Ctrl+Shift+I`) auf der **Host**-Seite → Registerkarte „Konsole“. Suchen Sie nach den Hinweisen `[WebRTC]` (Ladder-Telemetrie), `[PPS]` (Viewer Flood Kick), `[Congestion]` (Bitratengründe) und `[codec]` (H264/VP9-Auswahl und iGPU-Erkennung).
– `npm test` (nur Quell-Builds) validiert den Server: Boot, virtuelles Audio, REST-APIs und WebSocket-Handshake – `Verification Complete!` bedeutet, dass der Kern fehlerfrei ist.

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.