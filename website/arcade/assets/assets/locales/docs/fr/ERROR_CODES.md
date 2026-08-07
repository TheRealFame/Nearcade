# Codes d'erreur

Si Nearcade rencontre un problème, il affichera un code d'erreur standardisé.

### Erreurs réseau
- **E10** : Échec de la collecte ICE. Votre pare-feu bloque peut-être complètement le trafic WebRTC STUN.
- **E11** : Signalisation WebSocket déconnectée. L'hôte ou le tunnel est peut-être hors ligne.

### Erreurs de saisie
- **E20** : Échec de la création du contrôleur virtuel (Windows). Assurez-vous que ViGEmBus est installé et à jour.
- **E21** : autorisation uinput refusée (Linux). L'hôte doit exécuter Nearcade avec les privilèges `/dev/uinput` appropriés.

### Erreurs audio
- **E30** : échec de la capture du périphérique de bouclage. Assurez-vous d'avoir déverrouillé le contexte audio en cliquant sur l'interface utilisateur.
- **E31** : Échec de la liste noire audio de l'application. Le backend PulseAudio/PipeWire a renvoyé une erreur.

### Général
- **E99** : exception générique non gérée. Consultez la console du développeur (`Ctrl+Shift+I`) pour plus de détails.
