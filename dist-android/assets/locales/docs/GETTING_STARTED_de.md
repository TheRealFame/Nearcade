# Erste Schritte mit Nearcade

Mit Nearcade können Sie mithilfe von WebRTC lokale Spiele über das Internet mit Freunden teilen.

## Hosting-Optionen
Sie haben zwei Möglichkeiten, eine Sitzung zu veranstalten.

1. Private Tunnel: Sie können über Cloudflare oder Zrok einen benutzerdefinierten Tunnel einrichten, um einen dauerhaften Link für Ihre Freunde zu erstellen. Dies funktioniert am besten für private Gruppen.
2. Nearsec Arcade: The Arcade ist ein öffentliches Verzeichnis zum Auffinden lokaler Koop-Spiele. Die Sitzungen sind auf 80 Minuten begrenzt, um die Lobby aktiv zu halten. Sie müssen einen verifizierten Tunnelanbieter wie Cloudflared oder Zrok verwenden, um eine Sitzung aufzulisten. Sie können die öffentliche Lobby unter https://nearcade.cutefame.net/arcade ansehen und an aktiven Spielen teilnehmen.

## Starten einer Sitzung
Befolgen Sie diese Schritte, um mit dem Hosting zu beginnen.

1. Installieren Sie Node.js Version 18 oder neuer und Python 3 auf Ihrem Computer.
2. Die meisten Benutzer starten die kompilierte ausführbare Datei direkt. Die App verwaltet Berechtigungen und Tunnel automatisch.
3. Wenn Sie den Quellcode verwenden, öffnen Sie Ihr Terminal und navigieren Sie zum Ordner „bin“, um das Setup-Skript auszuführen.

    ```bash
    cd bin
    sudo ./linux_setup.sh
    ```

4. Die Linux-Anwendung fordert die Erlaubnis zum Laden des uinput-Kernelmoduls an. Dieser Schritt ist erforderlich, um native virtuelle Controller zu erstellen.
5. Klicken Sie auf die Schaltfläche „Sitzung hosten“, um das Erfassungs-Dashboard zu öffnen.
6. Senden Sie den generierten Link und die Sitzungs-PIN an Ihre Zuschauer. Der Rust-Router blockiert alle Video- und Audiostreams, bis die Hostanwendung die PIN vom Viewer validiert.

Dieses Projekt nutzt große Sprachmodelle mit künstlicher Intelligenz zur Codegenerierung und Strukturplanung.
