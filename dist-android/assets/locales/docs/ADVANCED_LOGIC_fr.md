Ce document fournit une analyse approfondie des systèmes sous-jacents qui alimentent Nearcade. Il est destiné aux développeurs, contributeurs et utilisateurs expérimentés qui ont besoin de comprendre le flux de données exact de WebRTC, de la virtualisation audio Linux et de l'injection d'entrée au niveau du noyau.

## Table des matières
1. [Architecture d'injection d'entrée] (#1-architecture-d'injection-d'entrée)
2. [Pipeline de virtualisation audio] (#2-pipeline-audio-virtualisation)
3. [La couche de transport WebRTC](#3-la-couche-de-transport-webrtc)
4. [Capture vidéo et Wayland] (#4-capture-vidéo--wayland)
5. [État de connexion et nettoyage] (#5-état de connexion-nettoyage)

---

### 1. Architecture d'injection d'entrée
Nearsec s'appuie sur un processus side-car Python distinct (`input_driver.py`) pour gérer l'injection d'entrée au niveau du système d'exploitation. Le serveur Node.js reçoit des WebSockets contenant des tableaux binaires d'API Gamepad, les décompresse dans des structures JSON standard et les redirige vers Python via « stdin ».

**Implémentation Linux `uinput`**
Sous Linux, nous utilisons le module noyau « uinput ». Les émulateurs traditionnels combinent souvent les fonctionnalités de la souris, du clavier et de la manette de jeu en un seul périphérique virtuel composite. Cela provoque de graves problèmes dans les moteurs de jeu modernes (comme Unreal Engine 5 ou Unity), qui interrogent de manière agressive les appareils et confondent souvent la dérive du stick analogique avec le mouvement de la souris, provoquant un scintillement de l'interface utilisateur.

Pour résoudre ce problème, `linux_uinput.py` isole strictement les périphériques :
* Les manettes de jeu sont générées explicitement en tant qu'appareils « Xbox 360 » (VID « 0x045e », PID « 0x028e ») ou « DualSense ».
* Les événements clavier/souris sont générés sur des bus USB virtuels entièrement séparés.
* Lorsqu'un utilisateur modifie son profil d'entrée (par exemple, en passant de Gamepad à Emulated KBM), le script Python appelle activement `old_gp.destroy()` pour couper physiquement le câble USB virtuel dans le noyau avant d'initialiser le nouveau profil. Cela évite "l'inondation du contrôleur" où les jeux plantent en raison de la détection de plus de 16 contrôleurs morts.

---

### 2. Pipeline de virtualisation audio
Le routage audio spécifique à une application sous Linux sans capturer les notifications du bureau ou le chat vocal Discord nécessite de manipuler directement le graphique PipeWire/PulseAudio.

**Le système de bouclage hybride**
Lorsque le serveur Node.js démarre, `initVirtualAudio()` exécute une chaîne de commandes `pactl` :
1. **Module Null Sink :** Crée « NearsecAppAudio ». Cela agit comme un trou noir numérique. Il s'agit d'un périphérique de sortie que les jeux peuvent cibler.
2. **Source de remappage du module :** Crée « NearsecAppMic ». Cela mappe le moniteur du trou noir à un périphérique d'entrée reconnaissable (un microphone) que l'API « getUserMedia » du navigateur peut capturer en toute sécurité.
3. **Module Loopback :** Crée un fil invisible et permanent depuis le récepteur « NearsecAppAudio » directement vers les écouteurs physiques de l'hôte.
4. **Contrôle du volume :** Nous exécutons explicitement `pactl set-sink-volume NearsecAppAudio 70%` pour garantir que le bouclage ne provoque pas d'écrêtage ou de dommages auditifs lorsqu'il est combiné avec le volume du système local.

**Routage automatique et listes noires**
La fonction `routeGameAudio()` dans `server.js` s'interface avec une bibliothèque Patchbay pour lire tous les nœuds audio actifs sur le système. Au lieu de mettre les jeux sur liste blanche, il utilise une liste noire intelligente (`AUDIO_BLACKLIST = ['discord', 'teamspeak', 'telegram']`). Toutes les 3 secondes, il recherche de nouveaux binaires d'application émettant du son ; s'ils ne sont pas sur la liste noire, il relie physiquement leurs nœuds de sortie PipeWire au récepteur « NearsecAppAudio ».

---

### 3. La couche de transport WebRTC
Nearsec n'est pas un serveur de streaming traditionnel ; il s'agit d'un serveur de signalisation qui orchestre les connexions directes Peer-to-Peer (P2P).

** Négociation ICE et TURN **
Étant donné que la plupart des téléspectateurs résident derrière des routeurs Symmetric NAT, les connexions directes STUN échouent fréquemment. Nearsec atténue cela en injectant les informations d'identification du serveur OpenRelay TURN dans la configuration « RTCPeerConnection ». Si un punch-through UDP direct échoue, le trafic retombe sur le port TCP 443 via le relais TURN, garantissant un taux de réussite de connexion de 99 %, même sur des réseaux d'entreprise ou universitaires stricts.

**Audio bidirectionnel (chat vocal)**
Pour mettre en œuvre la voix sur IP (VoIP) sans paralyser la bande passante de téléchargement de l'hôte, Nearsec utilise une architecture « Switchboard ».
* Les téléspectateurs capturent leur microphone local et attachent la piste à leur « RTCPeerConnection » sortante.
* L'hôte reçoit ces pistes et génère des balises `<audio autoplay>` cachées.
* L'hôte *ne* rediffuse pas cet audio à d'autres téléspectateurs. Au lieu de cela, le navigateur local de l'hôte mélange nativement les pistes audio WebRTC entrantes et les transmet aux haut-parleurs physiques, contournant complètement le récepteur « NearsecAppAudio » pour éviter des boucles de rétroaction infinies.

---

### 4. Capture vidéo et Wayland
La capture d'écran sous Linux est notoirement fragmentée. Nearsec exploite le «desktopCapturer» d'Electron associé aux indicateurs Chromium modernes pour prendre en charge en douceur les compositeurs X11 et Wayland.

Lorsqu'il est exécuté sous Wayland, Electron délègue la demande de capture d'écran au portail de bureau XDG natif (`xdg-desktop-portal`). Cela affiche une boîte de dialogue native du système d'exploitation demandant à l'utilisateur l'autorisation de partager un écran ou une fenêtre.

Ce portail nécessitant une interaction humaine, il existe un retard inhérent. Si l'hôte envoie une offre WebRTC avant que le portail Wayland ne renvoie la piste vidéo, la boucle de négociation plante. Pour résoudre ce problème, `viewer.js` force la collecte "Vanilla ICE" : il attend que `e.candidate === null` avant d'envoyer sa réponse SDP. Cela bloque artificiellement la poignée de main juste assez longtemps pour que le portail Wayland puisse allouer avec succès le flux vidéo PipeWire et l'attacher à l'expéditeur.

---

### 5. État de la connexion et nettoyage
La stabilité dans un environnement P2P multi-clients nécessite un garbage collection agressif.

**Atténuation des ports fantômes**
Si l'application Electron est fermée de force, Node.js peut laisser des tunnels « cloudflared » orphelins ou des ports TCP bloqués. Au démarrage, Nearsec utilise « kill-port » pour nettoyer le port 3000, garantissant ainsi que le serveur Express peut se lier proprement.

**Appareils virtuels orphelins**
De même, si le side-car Python est interrompu brusquement, les périphériques « uinput » restent actifs pour toujours dans le répertoire « /dev/input/ ». Le hook `cleanup()` de Node.js intercepte les événements `SIGINT`, `SIGTERM` et Electron `window-close`. Avant de quitter, il envoie une charge utile JSON finale `{ type: 'destroy_all' }` au Python `stdin`, forçant Python à désenregistrer tous les contrôleurs. Il émet simultanément une commande `pactl unload-module` ciblant spécifiquement l'entier `loopbackModuleId` enregistré lors du démarrage, détruisant proprement les câbles audio virtuels et restaurant le graphe audio Linux à son état par défaut.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.
