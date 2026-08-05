# Dépannage et récupération après incident

Ce guide couvre les scénarios de plantages, de blocages et de « cela a juste cessé de fonctionner » les plus courants signalés sur Nearcade, ainsi que les étapes exactes à suivre pour récupérer de chacun d'entre eux. Il est écrit pour les hôtes et les utilisateurs expérimentés – aucune connaissance en code n’est requise.

## Table des matières
1. [Le spectateur voit un écran noir](#1-le spectateur-voit-un-écran-noir)
2. [L'image du flux se détériore lentement avec le temps] (#2-l'image du flux-se-pire-lentement avec le temps)
3. [La session ne se connecte jamais (bloquée sur "Connexion")] (#3-session-jamais-connecte-bloquée lors de la connexion)
4. [Contrôleur virtuel non détecté par le jeu](#4-contrôleur-virtuel-non-détecté-par-jeu)
5. [Buzz audio assourdissant après l'arrêt de l'hôte (Linux)](#5-deafening-audio-buzz-after-the-host-shuts-down-linux)
6. [Le chat vocal fait écho ou renvoie] (#6-voice-chat-echoes-or-feeds-back)
7. [Le navigateur/la session plante sur une connexion très faible] (#7-browsercapture-fails-on-a-very-faible-network)
8. [La liste montre les joueurs fantômes/en double] (#8-roster-shows-ghost-or-duplicate-players)
9. [Un spectateur est parti mais ses commandes restent branchées](#9-un-spectateur-à gauche-mais-leurs-contrôles-restent-branchés)
10. [Écran d'erreur permanente non gérée après un changement de matériel] (#10-écran-d'erreur-permanente-non gérée-après-un-changement de matériel)

---

### 1. Le spectateur voit un écran noir

**Symptôme :** Le spectateur se connecte correctement (la liste les affiche, l'audio peut même fonctionner) mais la vidéo est noire en permanence.

**Pourquoi cela se produit :** Le décodeur WebCodecs n'a jamais reçu sa configuration de codec. Il s'agit d'une course connue : lorsque le réseau hôte effectue une sauvegarde, l'hôte supprime intentionnellement les données non critiques pour maintenir le flux en vie - mais il ne doit **jamais** supprimer le paquet de configuration JSON qui démarre le `VideoDecoder` du spectateur. Si ce paquet est manqué, le décodeur ne pourra jamais s'initialiser et restera noir pour toujours, même après la récupération du réseau.

**Réparer:**
1. Demandez au spectateur d'actualiser la page (F5) – ne vous contentez pas d'attendre.
2. Si cela se produit encore à plusieurs reprises, réduisez le débit/résolution de l'hôte d'un cran et reconnectez-vous ; moindre contrainte = moins de chutes forcées.
3. Confirmez auprès de l'hébergeur que son téléchargement Internet n'est pas saturé (la pilule verte "Live" convient ; une pilule jaune/rouge signifie que l'encodeur est en train de sauvegarder).

---

### 2. La latence du flux s'aggrave lentement avec le temps

**Symptôme :** Le jeu fonctionne correctement au début, mais après 10 à 20 minutes, la vue en direct est de plus en plus en retard et ne se rétablit jamais d'elle-même.

**Pourquoi cela se produit :** Canaux de données WebRTC et tampon WebSockets **à l'infini**. Si rien n’impose une suppression, l’encodeur met lentement en file d’attente les images obsolètes et la latence devient permanente. Nearcade applique cela avec des contrôles `bufferedAmount` qui suppriment les images obsolètes et forcent une image clé - mais si une session plus ancienne (ou une session démarrée avant la version actuelle) est en cours d'exécution, cette protection peut ne pas être appliquée.

**Réparer:**
1. Premièrement : arrêtez et redémarrez la session (supprime le tampon obsolète).
2. S'il continue de croître, mettez à jour le client hôte vers une version actuelle.
3. Évitez d'exécuter l'hôte sur un réseau Wi-Fi partageant la même connexion que les téléchargements volumineux.

---

### 3. La session VIP ne connecte jamais les commandes (bloquées en connexion)

**Symptôme :** La vidéo fonctionne mais aucun bouton/contrôleur ne répond – ou toute la session reste sur « Connexion… » pendant plus de 15 s.

**Pourquoi cela se produit :** WebRTC a besoin de candidats STUN/TURN. Si votre réseau permute entre les profils saisis (par exemple, un relais TURN public mort ou lent est dans le pool), la prise de contact peut s'arrêter pendant plusieurs secondes pendant que certains serveurs expirent. L'échelle est censée essayer d'abord des serveurs rapides et fiables, puis des relais communautaires en dernier recours.

**Réparer:**
1. Attendez jusqu'à environ 25 s : l'échelle finit par tomber en panne et se connecte.
2. S'il s'agit d'un écran "Connexion" dur pendant quelques minutes, actualisez matériellement l'URL de la visionneuse (ou rouvrez le lien sans `/` final).
3. Pour l'hôte : ajoutez votre propre serveur TURN de confiance dans Paramètres → Serveurs TURN communautaires. Un relais personnalisé réactif rend les poignées de main quasi instantanées.

---

### 4. Contrôleur virtuel jamais créé par votre jeu

**Symptôme :** Le spectateur a rejoint le mode Manette de jeu, mais aucun contrôleur n'apparaît dans le jeu.

**Pourquoi cela se produit :** Le contrôleur virtuel est créé par un pilote côté noyau, qui nécessite soit des privilèges accordés au moment de l'installation sous Linux, soit le pilote ViGEmBus tiers sous Windows.

**Réparer:**
- **Windows :** Installez ViGEmBus (l'assistant d'installation vous le demande). Vérifiez que le pilote existe sous Gestionnaire de périphériques → Périphériques logiciels → *ViGEm Bus Enumerator*.
- **Linux :** L'hôte a besoin d'un accès en écriture à `/dev/uinput`. Vérifiez auprès de votre script d'installation : exécutez `bin/linux_setup.sh` (ou `sudo modprobe uinput`), puis redémarrez l'hôte.
- Si le Wingamepad *fonctionnait auparavant* puis s'est arrêté, assurez-vous que l'application hôte n'a pas été mise à jour en cours de conduite - les gestionnaires d'entrée doivent fonctionner avec la même version que l'interface utilisateur Web. Redémarrez complètement l'application hôte.

---

### 5. Buzz audio assourdissant après l'arrêt de l'hôte (Linux)

**Symptôme :** Après la fermeture de l'hôte, les haut-parleurs émettent un bourdonnement fort et permanent qui ne s'arrête pas.

**Pourquoi cela se produit :** Le moteur audio virtuel Linux est démonté dans un ordre spécifique : le module de bouclage doit être déchargé **avant** le récepteur nul. L'ordre inversé laisse un fil de bouclage pointant vers un récepteur mort, produisant un bourdonnement jusqu'à ce que PulseAudio soit tué.

**Correction (immédiate) :**
```bash
pactl list short modules   # note the module IDs
pactl unload-module <loopback_module_id>   # unload ringback FIRST
pactl unload-module <null_sink_module_id>  # then the sink
```
S'il ne s'arrête pas, redémarrez le démon audio :
-PulseAudio : `pulseaudio -k && systemctl --user restart pulseaudio`
- PipeWire : `systemctl --user restart pipewire pipewire-pulse`

Utilisez toujours le bouton normal « Arrêter la session / Quitter » de l'interface utilisateur de l'hôte plutôt que de tuer l'application en cours de session : l'application effectue ce démontage dans le bon ordre lors d'une sortie propre.

---

### 6. Le chat vocal fait écho ou renvoie des informations

**Symptôme :** Les spectateurs s'entendent eux-mêmes ou entendent tout ce que joue le bureau hôte.

**Pourquoi cela se produit :** Les voix des spectateurs sont acheminées vers le périphérique de sortie physique de l'hôte. S'ils sont acheminés vers le récepteur de capture *virtuel*, le bouclage audio du jeu les récupère et crée un écho sans fin.

**Réparer:**
1. Hôte : le routage est automatique — assurez-vous que la capture « Application Audio » utilise le récepteur virtuel dédié (et non le récepteur du bureau/casque).
2. Si un écho apparaît après avoir modifié le périphérique de sortie audio de l'hôte, celui-ci doit revenir aux paramètres du périphérique et sélectionner la sortie physique (et non le récepteur virtuel) pour le chat vocal.

---

### 7. L'hôte/la capture échoue sur un réseau très faible, ou une session s'arrête lorsqu'un spectateur pilote un périphérique

**Symptôme :** La capture s'arrête, la liste se fige ou l'hôte se déconnecte lorsque de nombreux spectateurs rejoignent/partent ou lorsque quelqu'un active un traitement lourd (par exemple, streaming + VR en même temps).

**Pourquoi cela se produit :** Les suppressions de trames agressives et les démontages par remplacement à chaud nécessitent beaucoup de ressources ; sur les hôtes faibles, cela sature et le navigateur récupère un flux en cours de vol.

**Réparer:**
1. Réduisez la résolution/le débit binaire maximum de l'hôte.
2. Utilisez le mode « Entrée uniquement » lors de la diffusion **en externe** (Discord/OBS) — cela arrête le traitement vidéo pour la capture externe, libérant ainsi la machine.
3. Activez/maintenez « Égalisation du délai de l'hôte » activé : il prend en compte dynamiquement le temps d'encodage/de transmission afin que les entrées restent synchronisées en cas de gigue.
4. En VR : gardez le WiVRn RGB et le son virtuel en dehors des mêmes segments de réseau que la session.

---

### 8. La liste montre les joueurs fantômes/en double

**Symptôme :** Les joueurs restent dans la liste après leur départ ou apparaissent deux fois.

**Pourquoi :** Le Roster DOM est restitué à partir des messages WebSocket asynchrones. Un bug classique consiste à ajouter de nouveaux éléments après les anciens dans une coche distincte, produisant des doublons. Le code corrigé s'efface et se reconstruit dans le même bloc synchrone — si vous voyez toujours cela, le client est obsolète.

**Réparer:**
1. Actualisez matériellement l'hôte (`Ctrl+Shift+R`).
2. Si vous exécutez un client hôte personnalisé à partir des sources, extrayez la dernière version.
3. Attendez quelques secondes ; le serveur élimine lui-même les téléspectateurs morts.

---

### 9. Un spectateur est parti, mais sa manette reste "appuyée"

**Symptôme :** Après le départ de quelqu'un, une touche/un bouton reste enfoncé dans le jeu.

**Pourquoi :** L'hôte doit relire une charge utile « état de repos » afin que les boutons maintenus enfoncés soient relâchés lors de la déconnexion. Cela fonctionne lorsque la déconnexion est gérée proprement (le spectateur clique sur Quitter). Si l'onglet du spectateur a été supprimé brusquement, le contrôleur virtuel peut persister jusqu'à ce que le battement de cœur du serveur l'expire.

**Réparer:**
1. Expulsez le visualiseur obsolète de la liste (le chemin d'exclusion force la libération).
2. Si un emplacement reste bloqué, désactivez puis réactivez le verrouillage de l'emplacement du spectateur ou redémarrez la session : le périphérique virtuel est détruit et recréé proprement.

---

### 10. Écran permanent "Exception non gérée" après un changement de matériel

**Scénario :** La session est morte avec E99 (ou vous voyez un toast d'erreur rouge), et maintenant même le redémarrage de la session n'aide pas, par ex. après avoir ajouté/supprimé un GPU ou un périphérique audio.

**Pourquoi :** L'application contient des références à un MediaStream/`peerConnection` mort et le `try/catch` le plus proche pour la mutation est manquant, donc le démontage est lancé avant le nettoyage.

**Réparer:**
1. Quittez complètement l'application hôte (pas seulement fermez la session).
2. Vérifiez que les pilotes audio/GPU au niveau du système d'exploitation sont OK (l'appareil est toujours visible par les autres applications).
3. Rouvrez l'hôte. Les hooks de nettoyage enveloppent désormais le démontage dans try/catch et hard-stop/null chaque piste – cela libère le handle de périphérique obsolète.
4. Si le jeu n'a jamais contribué au flux, supprimez et rajoutez l'instance.

---

## Se déboguer rapidement

- Ouvrez le navigateur DevTools (`Ctrl+Shift+I`) sur la page **hôte** → onglet Console. Recherchez les notes `[WebRTC]` (télémétrie en échelle), `[PPS]` (coup de pied d'inondation du spectateur), `[Congestion]` (raisons du débit binaire) et `[codec]` (sélection H264/VP9 et détection iGPU).
- `npm test` (versions sources uniquement) valide le serveur : démarrage, audio virtuel, API REST et poignée de main WebSocket – `Verification Complete!` signifie que le noyau est sain.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.