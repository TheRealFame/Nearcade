# Configuration VPS

Si vous ne pouvez pas ouvrir de ports (à cause de CGNAT ou de pare-feu stricts), vous pouvez acheminer votre trafic Nearcade via un VPS cloud bon marché.

### 1. Prérequis
- Un VPS cloud sous Linux (Ubuntu, Debian ou Oracle Cloud Linux)
- Accès SSH au VPS
- Nearcade installé sur votre PC hôte local

### 2. Configurer le routeur VPS
Le routeur VPS Nearsec (répertoire `/vps`) gère la signalisation WebSocket et le proxy du trafic de négociation WebRTC.
Sur votre VPS, téléchargez la version Nearsec et exécutez le routeur :
```bash
./nearsec-router --port 8080
```

### 3. Connecter l'hôte
Dans les paramètres de l'application Nearsec, sous **Dedicated Tunnel Provider**, configurez votre IP et votre port VPS.
Une fois configurées, toutes les données de négociation P2P seront renvoyées sur le VPS au lieu d'exiger que les téléspectateurs se connectent directement à votre réseau domestique.
