# Nearcade Arcade

Die Nearcade Arcade ist ein globaler Matchmaking-Dienst, bei dem jeder seine aktiven Sitzungen öffentlich auflisten kann.

### Auflisten Ihrer Sitzung
Klicken Sie beim Starten einer Host-Sitzung auf den Schalter „Auf Live Arcade auflisten“. Ihre Sitzung wird sofort auf der Registerkarte „Arcade“ für alle Nearcade-Benutzer angezeigt.

### Sicherheit
- **Kein direkter IP-Leckage**: Wenn Sie einen Tunnel (Zrok, Cloudflared) oder einen VPS verwenden, wird Ihre echte Heim-IP-Adresse aus der Arcade-Liste maskiert.
- **PIN-Schutz**: Sie können bei Arcade-Sitzungen weiterhin einen PIN-Code erzwingen. Zuschauer sehen Ihre Lobby, müssen jedoch die PIN kennen, um beitreten zu können.

### Arcade-Herzschläge
Die Host-Anwendung sendet alle 30 Sekunden einen „Heartbeat“-Ping an die Arcade. Wenn Sie Nearcade schließen oder die Verbindung verlieren, wird Ihr Eintrag innerhalb einer Minute automatisch entfernt.
