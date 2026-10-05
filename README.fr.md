<p align="left">
  <img src="assets/NearcadeTitle.png" width="400">
<h1>Nearcade <a href="https://discord.gg/Yz3NeEBdPQ" target="_blank" title="Join our Discord"><img src="https://img.icons8.com/?size=100&id=M725CLW4L7wE&format=png&color=000000" width="28" height="28" style="vertical-align:middle;"></a></h1>

[Anglais](README.md)\|[Espagnol](README.es.md)\|[Français](README.fr.md)\|[Allemand](README.de.md)\|[portugais](README.pt.md)\|[japonais](README.ja.md)

## Captures d'écran - Tableau de bord, page de visualisation, Arcade

<div align="center">
  <img src="assets/screenshots/nearcade-client-home.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-host.png" alt="Nearcade Host" width="45%">
  <img src="assets/screenshots/nearcade-viewer.png" alt="Nearcade Viewer" width="45%">
  <img src="assets/screenshots/nearcade-arcade.png" alt="Nearcade Arcade" width="45%">
</div>

## Mission du projet

Nearcade est une plateforme open source qui vous permet de jouer à des jeux coopératifs locaux sur Internet avec des amis. Il est conçu pour les configurations auto-hébergées. Il utilise des connexions peer-to-peer et le routage audio et d'entrée natif du système d'exploitation pour maintenir un faible délai d'entrée.

L'accent principal est mis sur les configurations privées. L'application hôte ne nécessite aucune configuration réseau particulière. Les téléspectateurs rejoignent via un navigateur Web standard sur un ordinateur de bureau ou un appareil mobile. L'interface de visualisation mobile comprend des commandes tactiles et un joystick virtuel. Les utilisateurs n'ont pas besoin de télécharger quoi que ce soit pour jouer.

## Configuration système requise

Vous avez besoin d'un logiciel spécifique installé sur votre ordinateur pour exécuter l'application hôte.

### Logiciel requis

-   Node.js version 18 ou ultérieure.
-   Python 3 pour le pont de virtualisation du contrôleur.
-   Git pour télécharger le code source.

### Configuration requise pour Linux

-   PipeWire doit être votre serveur audio actif. L'application cible directement les nœuds PipeWire pour séparer l'audio du jeu des discussions vocales. Cela ne fonctionnera pas avec PulseAudio.
-   Votre noyau doit avoir le module uinput activé pour que l'application puisse créer des manettes de jeu virtuelles natives.
-   Le système déploie des règles udev natives pour bloquer les indicateurs de confusion de la souris et du clavier. Cela contourne les limites normales d’entrée de Steam. Le script d'installation fourni gère cette étape.

### Configuration requise pour Windows

-   Vous devez installer le pilote ViGEmBus manuellement pour activer la prise en charge de la manette de jeu sous Windows.

### Dépendances groupées

L'application regroupe les binaires Cloudflared et Zrok pour le tunneling et les exécute de manière native. Vous n'avez pas besoin de les installer manuellement. Le routage réseau s'appuie sur un routeur Rust VPS externe pour la signalisation, tandis que le streaming multimédia s'effectue principalement via des pipelines WebCodecs à très faible latence ou WebRTC.

## Matrice de prise en charge de la plateforme

| Fonctionnalité                               | Linux      | Fenêtres     | macOS        |
| -------------------------------------------- | ---------- | ------------ | ------------ |
| Plateforme de streaming (WebCodecs / WebRTC) | Complet    | Complet      | Complet      |
| Prise en charge des manettes de jeu          | Complet    | Conditionnel | Aucun        |
| Entrée au clavier et à la souris             | Complet    | Limité       | Complet      |
| Multi-contrôleur                             | Complet    | Limité       | Aucun        |
| Lecture audio                                | Complet    | Complet      | Complet      |
| Niveau de stabilité                          | Production | Expérimental | Expérimental |

## Installation et documentation

La plupart des utilisateurs exécuteront directement le fichier exécutable compilé. L'application gère automatiquement la configuration du système au lancement.

Vous devez uniquement exécuter le script de configuration manuellement si vous utilisez le code source ou si l'application compilée ne parvient pas à configurer votre système. Pour exécuter manuellement le script d'installation Linux, accédez au dossier bin à partir de la racine du projet.

```bash
cd bin
sudo ./linux_setup.sh
```

Nous conservons toutes les instructions de configuration technique, les listes de dépendances et les guides API dans un répertoire de documentation dédié. Cela permet de garder la page principale propre. Vous pouvez lire ces fichiers à partir de l'icône du livre du tableau de bord de l'hôte ou en cliquant sur les liens ci-dessous.

-   [Guide de démarrage](src/docs/GETTING_STARTED.md)
-   [Manuel d'utilisation de l'hôte](src/docs/HOST_USAGE.md)
-   [API et guide de configuration](src/docs/API_AND_SETUP.md)
-   [Configuration du serveur VPS](src/docs/VPS_SETUP.md)
-   [Documentation de logique avancée](src/docs/ADVANCED_LOGIC.md)
-   [Informations sur l'arcade Nearcade](src/docs/NEARCADE_ARCADE.md)

## Arcade Nearcade

La plateforme comprend un système de lobby public en option. Les hôtes peuvent répertorier leurs sessions sur la grille Arcade pour permettre aux joueurs du monde entier de découvrir et de rejoindre des jeux coopératifs locaux. Vous pouvez voir le hall public à<https://nearcade.cutefame.net>et rejoignez des sessions actives directement depuis votre navigateur.

## Script utilisateur du navigateur (persistance de l'identité)

Votre nom d’affichage et la couleur de votre chat sont enregistrés uniquement par site par défaut. Le script utilisateur de persistance d'identité a été migré vers le[OuvrirRemotePlay](https://github.com/TheRealFame/OpenRemotePlay)référentiel pour agir comme un gestionnaire d'identité universel pour toute plateforme utilisant le protocole OpenRemotePlay.

Installez ce script utilisateur universel avec[Tampermonkey](https://www.tampermonkey.net/)ou n'importe quel fork et votre identité vous suivra de manière transparente dans toutes les sessions Nearcade — tunnels Cloudflare, zrok, localhost, n'importe où.

[Installer OpenRemotePlay Identity Persist](https://github.com/TheRealFame/OpenRemotePlay/raw/main/openremoteplay-identity-persist.user.js)

## Protocole ouvert de lecture à distance (ORP)

La couche de connexion peer-to-peer de Nearcade constitue la base de[Ouvrir la lecture à distance](https://github.com/TheRealFame/OpenRemotePlay), une spécification de protocole ouverte sous licence MIT pour l'interopérabilité de la lecture à distance entre des clients et des hôtes développés indépendamment. Le script utilisateur de persistance d'identité ci-dessus s'exécute déjà sur le protocole ORP aujourd'hui.

La spécification v2 plus large – signalisation sans serveur, budget de connexion défini de moins de 2 secondes, traversée NAT uniquement STUN avec un niveau de nouvelle tentative de perforation forcée et un modèle de confiance construit autour de la possession d'un code PIN plutôt que d'un secret partagé statique – est actuellement un projet, pas encore adopté dans le propre code de connexion de Nearcade. Signalisation existante de Nearcade (Trystero sur trackers BitTorrent, voir[Documentation de logique avancée](src/docs/ADVANCED_LOGIC.md)) est l'une des deux stratégies de signalisation formalisées par la spécification v2 ; la stratégie de course Nostr-primaire et le reste de la v2 n'ont pas encore été implémentés dans ce référentiel. Voir le[Spécification ORP](https://github.com/TheRealFame/OpenRemotePlay/blob/main/spec/ORP_SPEC.md)pour ce qui est couvert et ce qui est encore ouvert.

ORP n'est pas lié au pipeline WebCodecs/WebRTC spécifique de Nearcade. Tout projet peut utiliser la couche de connexion et de signalisation d'ORP avec son propre pipeline multimédia, et le[Référentiel ORP](https://github.com/TheRealFame/OpenRemotePlay#using-orp-with-your-own-pipeline)documente comment, y compris lorsqu'une pull request sur le protocole lui-même est le bon chemin pour un pipeline qui a besoin de quelque chose que la spécification actuelle ne fournit pas encore.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.
