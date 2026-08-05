# Host-Nutzungs- und Dashboard-Leitfaden

Das Host-Dashboard ist Ihr Kontrollzentrum für die Verwaltung von Streams, Zuschauern und Systemaudio.

## Video- und Audioaufnahme
Wenn Sie eine Sitzung starten, stellt Nearsec eine Verbindung zu Ihren nativen Betriebssystem-APIs wie Wayland, X11 oder Windows Graphics Capture her.
* Audio-Routing für Linux: Nearsec erstellt automatisch eine virtuelle NearsecVirtualCapture-Senke. Das System verwendet exakte PipeWire-Knoteneigenschaften, um Spielaudio automatisch in diese Senke zu leiten. Dadurch bleiben Ihre persönlichen Desktop-Audio- und Sprachchats vom Stream fern.
* Lautstärkeregelung: Die Lautstärke des virtuellen Waschbeckens wird automatisch auf 70 Prozent eingestellt, um Ihr Gehör zu schützen.

## Spielerliste und Eingabeberechtigungen
Zuschauer erscheinen im Kader, wenn sie beitreten. Sie haben die vollständige Kontrolle über ihre Eingabemodi.
* Gamepad: Erstellt einen nativen virtuellen Controller.
* Raw-Tastatur und -Maus: Direkteingabe-Passthrough.
* Emulierte Tastatur und Maus: Ordnet Tastatureingaben einem virtuellen Gamepad zu. Dies ist hilfreich, wenn Retro- oder Kampfspiele keine native Tastaturunterstützung bieten.
* Slots sperren: Klicken Sie auf das Vorhängeschloss-Symbol, um zu verhindern, dass zufällige Zuschauer einen aktiven Spielerslot übernehmen.

## Voice-Chat-Verwaltung
Zuschauer können ihr Mikrofon-Audio direkt an den Moderator senden.
* Rotes Mikrofonsymbol: Lokal stummgeschaltet. Sie werden sie nicht hören, aber ihr Ton kommt immer noch auf dem Server an.
* Graues Mikrofonsymbol: Stummschaltung erzwingen. Der Server verwirft seine Audiopakete vollständig, um Bandbreite für alle Benutzer zu sparen.

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.
