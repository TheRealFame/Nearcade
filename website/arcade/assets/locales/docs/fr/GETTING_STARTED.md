# Premiers pas avec Nearsec ensemble

Nearcade vous permet de partager des jeux locaux avec des amis sur Internet à l'aide de WebRTC.

## Options d'hébergement
Vous avez deux façons d’héberger une session.

1. Tunnels privés : vous pouvez configurer un tunnel personnalisé via Cloudflare ou Zrok pour créer un lien permanent pour vos amis. Cela fonctionne mieux pour les groupes privés.
2. Nearsec Arcade : The Arcade est un répertoire public permettant de trouver des jeux coopératifs locaux. Les sessions sont limitées à 80 minutes pour garder le lobby actif. Vous devez utiliser un fournisseur de tunneling vérifié comme Cloudflared ou Zrok pour répertorier une session. Vous pouvez consulter le lobby public sur https://nearcade.cutefame.net/arcade et rejoindre des jeux actifs.

## Lancement d'une session
Suivez ces étapes pour commencer l'hébergement.

1. Installez Node.js version 18 ou ultérieure et Python 3 sur votre ordinateur.
2. La plupart des utilisateurs lanceront directement l'exécutable compilé. L'application gère automatiquement les autorisations et les tunnels.
3. Si vous utilisez le code source, ouvrez votre terminal et accédez au dossier bin pour exécuter le script d'installation.

    ```bash
    cd bin
    sudo ./linux_setup.sh
    ```

4. L'application Linux demande l'autorisation de charger le module du noyau uinput. Cette étape est requise pour créer des contrôleurs virtuels natifs.
5. Cliquez sur le bouton Hôte de session pour ouvrir le tableau de bord de capture.
6. Envoyez le lien généré et le code PIN de session à vos spectateurs. Le routeur Rust bloque tous les flux vidéo et audio jusqu'à ce que l'application hôte valide le code PIN du spectateur.

Ce projet utilise de grands modèles de langage d'intelligence artificielle pour la génération de code et la planification de la structure.
