# Guide d'utilisation de l'hôte et du tableau de bord

Le tableau de bord hôte est votre centre de contrôle pour gérer les flux, les visionneuses et l'audio du système.

## Capture vidéo et audio
Lorsque vous démarrez une session, Nearsec se connecte aux API natives de votre système d'exploitation telles que Wayland, X11 ou Windows Graphics Capture.
* Routage audio pour Linux : Nearsec crée automatiquement un récepteur virtuel NearsecVirtualCapture. Le système utilise les propriétés exactes du nœud PipeWire pour acheminer automatiquement l'audio du jeu vers ce récepteur. Cela permet de garder vos discussions audio et vocales personnelles sur votre bureau hors du flux.
* Contrôle du volume : l'évier virtuel se limite automatiquement à 70 % du volume pour protéger votre audition.

## Liste des joueurs et autorisations d'entrée
Les téléspectateurs apparaissent dans la liste au fur et à mesure de leur inscription. Vous avez un contrôle total sur leurs modes de saisie.
* Manette de jeu : crée un contrôleur virtuel natif.
* Clavier et souris bruts : passthrough de saisie directe.
* Clavier et souris émulés : mappe les entrées du clavier sur une manette de jeu virtuelle. Cela est utile lorsque les jeux rétro ou de combat ne prennent pas en charge le clavier natif.
* Verrouiller les emplacements : cliquez sur l'icône du cadenas pour empêcher les spectateurs aléatoires de s'emparer d'un emplacement de joueur actif.

## Gestion du chat vocal
Les téléspectateurs peuvent envoyer le son de leur microphone directement à l'hôte.
* Icône de micro rouge : sourdine localement. Vous ne les entendrez pas mais leur audio arrive toujours au serveur.
* Icône grise du micro : Forcer la mise en sourdine. Le serveur abandonne entièrement ses paquets audio pour économiser la bande passante pour tous les utilisateurs.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.
