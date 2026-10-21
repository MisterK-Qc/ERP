# ArchiDoc

Logiciel d'archivage documentaire avec workflows d'approbation.

## Fonctionnalités

- **Archivage** : dépôt de fichiers (50 Mo max) avec titre, description et étiquettes ; aperçu intégré des PDF, images et fichiers texte ; téléchargement.
- **Versions** : chaque document peut recevoir de nouvelles versions (avec une note) ; toutes les versions restent téléchargeables et la recherche porte sur la version actuelle.
- **Dossiers et droits d'accès** : arborescence de dossiers ; chaque dossier peut restreindre l'accès à des utilisateurs ou groupes, en *lecture* ou *lecture et écriture*. Un dossier sans règle hérite de son parent ; à la racine, il est ouvert à tous. Les documents d'un dossier inaccessible n'apparaissent nulle part (tableau de bord, recherche, liens directs), sauf pour leur déposant et pour les personnes assignées à une étape en attente.
- **Workflows** : suites d'étapes assignées à un **utilisateur** ou à un **groupe**. Des étapes peuvent se dérouler **en parallèle** : toutes doivent être approuvées avant de passer à la suite. Un rejet (motif obligatoire) arrête le workflow ; le déposant peut le relancer.
- **Échéances et relances** : chaque étape peut avoir un délai en jours ; les étapes en retard sont signalées et une relance par courriel est envoyée une fois l'échéance dépassée.
- **Notifications par courriel** : aux assignés quand une étape commence, et au déposant quand son document est approuvé ou rejeté. Chaque utilisateur gère son adresse et peut se désabonner depuis « Mon profil ».
- **Tableau de bord** : documents en attente d'une action de ma part (les retards en premier), mes derniers dépôts et statistiques.
- **Recherche plein texte** : dans le titre, la description, les étiquettes, le nom du fichier **et le contenu** des PDF, Word (.docx), HTML et fichiers texte. Accents ignorés, début de mot accepté, extrait avec les termes surlignés. Filtres par dossier (sous-dossiers inclus), statut, workflow, déposant et période.
- **Historique** : chaque document garde la trace des dépôts, versions, validations, rejets et commentaires.
- **Administration** : utilisateurs (avec courriel), groupes, dossiers et droits, workflows (éditeur d'étapes avec parallélisme et délais).

## Démarrage

Prérequis : Node.js 22.13 ou plus récent (utilise le module intégré `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
```

Comptes de démonstration créés au premier lancement :

| Identifiant | Mot de passe | Rôle |
|---|---|---|
| admin | admin | Administrateur, groupe Direction |
| alice | alice | Utilisatrice (étape « Vérification ») |
| bob | bob | Utilisateur, groupe Finance |

Un workflow d'exemple « Approbation de facture » est fourni : Vérification (Alice) → Validation Finance (groupe Finance) → Approbation Direction (groupe Direction).

Un second workflow « Revue de contrat » montre les étapes parallèles : Revue juridique (Alice) et Revue financière (Finance) en même temps, puis Signature (Direction). Le dossier « Ressources humaines » est réservé au groupe Direction (écriture) et à Alice (lecture).

### Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Base SQLite et fichiers déposés |
| `SMTP_URL` | — | Serveur d'envoi, p. ex. `smtps://utilisateur:motdepasse@smtp.exemple.com:465`. Sans cette variable, les courriels sont seulement affichés dans la console. |
| `MAIL_FROM` | `ArchiDoc <no-reply@archidoc.local>` | Expéditeur des courriels |
| `APP_URL` | `http://localhost:3000` | Adresse publique utilisée dans les liens des courriels |
| `REMINDER_INTERVAL_MINUTES` | `15` | Fréquence de vérification des étapes en retard |

La base est mise à niveau automatiquement au démarrage (migrations versionnées dans `src/db.js`).

## Tests

```bash
npm test
```

## Architecture

- `src/app.js` — API REST Express (authentification, utilisateurs, groupes, workflows, documents, tableau de bord, recherche).
- `src/db.js` — schéma SQLite, migrations et données de démonstration.
- `src/access.js` — droits d'accès par dossier (héritage, lecture/écriture).
- `src/extract.js` — extraction du texte des fichiers pour l'index plein texte (FTS5).
- `src/notify.js` — notifications par courriel (nodemailer).
- `src/auth.js` — mots de passe (scrypt) et sessions par cookie.
- `public/` — interface web monopage en JavaScript natif.

## Pistes pour la suite

- OCR des documents numérisés (images, PDF sans texte).
- Métadonnées personnalisées par type de document.
- Étapes conditionnelles, délégation (absences) et renvoi à l'étape précédente.
- Règles de conservation et d'archivage légal (durées, destruction, gel).
