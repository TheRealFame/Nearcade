# Fehlercodes

Wenn Nearcade auf ein Problem stößt, wird ein standardisierter Fehlercode angezeigt.

### Netzwerkfehler
- **E10**: ICE-Sammeln fehlgeschlagen. Möglicherweise blockiert Ihre Firewall den WebRTC-STUN-Verkehr vollständig.
- **E11**: Signalisierungs-WebSocket getrennt. Der Host oder Tunnel ist möglicherweise offline gegangen.

### Eingabefehler
- **E20**: Erstellung des virtuellen Controllers fehlgeschlagen (Windows). Stellen Sie sicher, dass ViGEmBus installiert und auf dem neuesten Stand ist.
- **E21**: Uinput-Berechtigung verweigert (Linux). Der Host muss Nearcade mit den entsprechenden `/dev/uinput`-Berechtigungen ausführen.

### Audiofehler
- **E30**: Loopback-Gerät konnte nicht erfasst werden. Stellen Sie sicher, dass Sie den Audiokontext entsperrt haben, indem Sie auf die Benutzeroberfläche klicken.
- **E31**: Blacklisting für Anwendungsaudio fehlgeschlagen. Das PulseAudio/PipeWire-Backend hat einen Fehler zurückgegeben.

### Allgemein
- **E99**: Nicht behandelte generische Ausnahme. Weitere Details finden Sie in der Entwicklerkonsole (`Ctrl+Shift+I`).
