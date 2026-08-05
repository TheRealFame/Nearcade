# Arcade de proximité

Nearsec Arcade est un service de mise en relation mondial où chacun peut répertorier publiquement ses sessions actives.

### Liste de votre session
Lorsque vous démarrez une session hôte, cliquez sur le bouton "Liste sur Live Arcade". Votre session apparaîtra immédiatement sur l'onglet Arcade pour tous les utilisateurs Nearsec.

### Sécurité
- **Aucune fuite IP directe** : Si vous utilisez un tunnel (zrok, cloudflared) ou un VPS, votre véritable adresse IP personnelle est masquée dans la liste Arcade.
- **Protection PIN** : Vous pouvez toujours appliquer un code PIN sur les sessions Arcade. Les téléspectateurs verront votre lobby mais doivent connaître le code PIN pour rejoindre.

### Battements de coeur d'arcade
L'application hôte envoie un ping "heartbeat" à l'Arcade toutes les 30 secondes. Si vous fermez Nearsec ou perdez la connexion, votre annonce sera automatiquement supprimée dans un délai d'une minute.
