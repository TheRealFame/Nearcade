# API et configuration du système

## Démarrage manuel
Si vous développez ou dépannez, vous souhaiterez peut-être exécuter les composants manuellement au lieu d'utiliser l'exécutable compilé. Nearsec nécessite que deux processus distincts s'exécutent simultanément. Il s'agit du pilote d'entrée Python et du serveur Web Node.js.

### Installation manuelle sous Linux
Linux nécessite les privilèges root pour injecter des contrôleurs virtuels directement dans le noyau via uinput.

Borne 1 pour le pilote d'entrée :
```bash
cd Nearcade
pip3 install -r bin/requirements-linux.txt
sudo python3 src/sidecar/input_driver.py
```

Terminal 2 pour le Serveur Web :
```bash
cd Nearcade
npm install
npm run electron
```

### Configuration manuelle sous Windows
Windows nécessite le pilote ViGEmBus pour émuler les contrôleurs.
1. Téléchargez et installez le pilote ViGEmBus.
2. Assurez-vous que Python 3 et Node 18 ou une version plus récente sont installés.

Borne 1 pour le pilote d'entrée :
```powershell
cd Nearcade
pip install -r bin/requirements-windows.txt
python src/sidecar/input_driver.py
```

Terminal 2 pour le Serveur Web :
```powershell
cd Nearcade
npm install
npm run electron
```

## Configuration de l'environnement
Pour empêcher le codage en dur des jetons sensibles, Nearsec s'appuie sur un fichier d'environnement situé dans votre répertoire racine.

Créez un fichier nommé .env et remplissez-le avec vos clés spécifiques.
```ini
CF_TOKEN=your_cloudflare_tunnel_token
CUSTOM_URL=[https://play.yourdomain.com](https://play.yourdomain.com)
PORT=3000
```

## Points de terminaison de l'API Express interne
Le serveur Nearsec Node expose les points de terminaison HTTP POST locaux pour contrôler le backend de manière dynamique.

Routage audio via /api/force-route
* Charge utile : { "nodeProperty": "target_node_id" }
* Action : force PipeWire à lier dynamiquement le nœud cible spécifique au récepteur NearsecVirtualCapture.

Gestion des processus via /api/restart-game
* Action : redémarre la séquence de capture.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.
