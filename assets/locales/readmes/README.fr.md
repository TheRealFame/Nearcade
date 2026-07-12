<p align="left">
  <img src="assets/NearcadeLogo.png" width="160" height="140">
<h1>Nearcade</h1>

[Anglais](README.md)\|[Espagnol](assets/locales/readmes/README.es.md)\|[Français](assets/locales/readmes/README.fr.md)\|[Allemand](assets/locales/readmes/README.de.md)\|[portugais](assets/locales/readmes/README.pt.md)\|[japonais](assets/locales/readmes/README.ja.md)

## Captures d'écran - Tableau de bord, page de visualisation, Arcade

<div align="center">
  <img src="assets/screenshots/nearsec-client-home.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-host.png" alt="Nearsec Host" width="45%">
  <img src="assets/screenshots/nearsec-viewer.png" alt="Nearsec Viewer" width="45%">
  <img src="assets/screenshots/nearsec-arcade.png" alt="Nearsec Arcade" width="45%">
</div>

## Description du projet

Nearcade est une plate-forme open source à faible latence qui vous permet de jouer à des jeux coopératifs locaux sur Internet avec vos amis. En tirant parti de WebRTC pour le streaming UDP et des encodeurs matériels de navigateur intégrés, Nearcade offre une latence presque imperceptible qui rivalise avec les plates-formes commerciales de jeux en nuage, spécialement conçues pour les instances auto-hébergées.

Contrairement aux solutions de cloud gaming traditionnelles qui reposaient sur d'énormes tuyaux de centre de données et des encodeurs matériels QUIC/VP9 personnalisés, Nearcade est optimisé pour fonctionner avec élégance sur une connexion Internet domestique standard.

## Pile technologique

-   **Les transports**: WebRTC gère automatiquement la mise en mémoire tampon de gigue et la traversée NAT.
-   **Le distributeur**: Pour éviter de surcharger la bande passante de téléchargement de votre réseau domestique lors de la diffusion vers plusieurs personnes, vous pouvez l'associer à une SFU (Selective Forwarding Unit) ou utiliser les options intégrées de redirection de port et de tunneling.
-   **L'encodeur**: Le logiciel accède à l'encodage matériel de votre système (NVENC, VAAPI) via l'API WebRTC pour fournir des flux H.264 ou VP8/VP9 optimisés en fonction de la qualité de votre connexion.

* * *

## Prise en charge de la plateforme

| Fonctionnalité                          |      Linux     |     Fenêtres     |       macOS      |
| --------------------------------------- | :------------: | :--------------: | :--------------: |
| **Diffusion WebRTC**                    |               |                 |                 |
| **Prise en charge des manettes de jeu** |      Plein    | ⚠ Conditionnel¹ |       Aucun     |
| **Entrée clavier/souris**               |      Plein    |     ⚠ Limité    |       Plein     |
| **Commandes de mouvement**              |               |                 |                 |
| **Multi-contrôleur**                    |               |     ⚠ Limité    |                 |
| **Lecture audio**                       |               |                 |                 |
| **Capture d'affichage**                 |               |                 |                 |
| **Stabilité**                           | **Production** | **Expérimental** | **Expérimental** |

¹ La manette de jeu Windows nécessite[Pilote ViGEmBus](https://github.com/nefarius/ViGEmBus/releases)

**[→ Guide de configuration détaillé de la plateforme](PLATFORM_SETUP.md)**— Instructions étape par étape, dépannage et solutions de contournement pour chaque plate-forme.

* * *

## Commencer

### Quoi`./start`gère automatiquement

-   Fonctionne`npm install`si`node_modules`est manquant – y compris Electron.
-   Charge le`uinput`module noyau sous Linux (via`sudo modprobe uinput`).
-   Retombe sans tête`node server.js`mode si Electron n’est pas installé.

### Ce que vous devez configurer vous-même

| Dépendance                  | Requis pour                              | Installer                                           |
| --------------------------- | ---------------------------------------- | --------------------------------------------------- |
| **Noeud.js**(v18+)          | Tout                                     | [nodejs.org](https://nodejs.org)ou`nvm`             |
| **Python3**+`python-uinput` | Virtualisation des entrées du contrôleur | `sudo ./linux_setup.sh`(Linux uniquement, une fois) |
| **module noyau uinput**     | Virtualisation des entrées du contrôleur | Inclus dans`linux_setup.sh`                         |

> **Les contrôleurs ne fonctionneront pas sans la configuration Python.**L'application se lancera et diffusera toujours correctement - les téléspectateurs ne pourront tout simplement pas envoyer une manette de jeu ou une saisie au clavier à l'hôte. Courir`sudo ./linux_setup.sh`une fois après le clonage pour l'activer.

> **Pour la configuration Windows/macOS**, voir[PLATFORM_SETUP.md](PLATFORM_SETUP.md)pour des instructions détaillées, les exigences et les limitations connues pour chaque plate-forme.

### Pas à pas

**Linux (recommandé – entièrement pris en charge)**

```bash
# 1. One-time system setup (installs python-uinput, udev rules, uinput)
sudo ./linux_setup.sh

# 2. Every subsequent launch
./start
```

**Windows/MacOS**_(expérimental — voir[PLATFORM_SETUP.md](PLATFORM_SETUP.md))_

```bash
# For detailed setup instructions, troubleshooting, and known limitations:
# → Read: PLATFORM_SETUP.md

./start
```

Node.js doit déjà être installé. Le script se terminera avec`Node.js missing`s'il n'est pas trouvé.

### Partager avec des amis

1.  Cliquez**Commencer le partage**dans l'interface hôte pour commencer la capture.
2.  Choisissez un fournisseur de tunnel (cloudflared recommandé – gratuit, aucun compte requis) ou configurez la redirection de port sur TCP 3000.
3.  Partagez le lien et le code PIN fournis avec vos amis. C'est ça.

* * *

## Sécurité

-   **Limitation du taux de code PIN**- le serveur WebSocket verrouille les adresses IP après des tentatives répétées de code PIN infructueuses.
-   **Contrôles de parité des versions**— les téléspectateurs sont immédiatement avertis si leur version client diffère de celle de l'hôte.
-   **Isolation des entrées**- Des autorisations strictes par spectateur empêchent les clients d'envoyer des entrées de clavier non autorisées ou de remplacer les emplacements de manette de jeu qu'ils ne possèdent pas.

* * *

## Dépannage

### Les contrôleurs ne fonctionnent pas

Courir`sudo ./linux_setup.sh`si ce n'est pas déjà fait. Vérifiez que`/dev/uinput`existe et est accessible en écriture. Le terminal enregistrera`[uinput] sidecar started`sur un lancement réussi.

### Pas de son dans le flux

Sur Wayland/PipeWire, la capture audio est gérée via la boîte de dialogue du portail de partage d'écran. Lorsque la boîte de dialogue de partage apparaît, assurez-vous**"Partager l'audio"**est coché. Si l'audio n'apparaît toujours pas après le partage, l'application tentera automatiquement un repli de boucle PipeWire et enregistrera le résultat.

### Échec de la négociation WebRTC/erreurs GPU

Si tu vois`vulkan_swap_chain.cc Swapchain is suboptimal`ou un GPU similaire plante dans le terminal, vos pilotes graphiques rejettent les indicateurs d'accélération matérielle d'Electron.

1.  Ouvrir`electron-main.js`.
2.  Trouver le`app.commandLine.appendSwitch('enable-features', ...)`bloc.
3.  Supprimez les drapeaux un par un (par ex.`VaapiVideoEncoder`,`VaapiVideoDecoder`) jusqu'à ce que le flux se stabilise.
4.  Si vous deviez les supprimer, l'application revient au codage logiciel (VP8/VP9) : utilisation plus élevée du processeur mais stable.

### Reconstruire Electron à partir de zéro

Si`npm install`ne parvient pas à extraire le binaire Electron correct pour votre architecture :

```bash
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

Sur des architectures inhabituelles, vous devrez peut-être construire Electron à partir de la source via`electron/build-tools`, mais cela est très rarement nécessaire.

* * *

## Progrès actuels

-   Interface utilisateur principale de l'hôte avec contrôles de capture WebRTC intégrés.
-   Redirection de port, Cloudflared et intégration de tunneling automatique.
-   Virtualisation des entrées du contrôleur via`uinput`pour un contournement transparent de l’entrée de vapeur.
-   Mise à l'échelle dynamique du débit binaire avec préférence de dégradation sélectionnable par l'utilisateur.
-   Interface utilisateur tactile mobile avec joystick virtuel et visée gyroscopique en option.
-   Mode Arcade : publiez votre session publiquement sur Nearsec Arcade pour que d'autres puissent la découvrir et la rejoindre.

* * *

_Ce projet a utilisé des LLM pour la génération de code._
