# ArchiDoc

Logiciel d'archivage documentaire avec workflows d'approbation.

## Fonctionnalités

- **Archivage** : dépôt de fichiers (50 Mo max) avec titre, description et étiquettes ; aperçu intégré des PDF, images et fichiers texte ; téléchargement.
- **Workflows** : suites d'étapes ordonnées, chacune assignée à un **utilisateur** ou à un **groupe**. À chaque étape, un assigné peut *approuver* (passage à l'étape suivante, ou approbation finale) ou *rejeter* (motif obligatoire). Le déposant peut relancer un workflow après rejet.
- **Tableau de bord** : documents en attente d'une action de ma part (directement ou via un de mes groupes), mes derniers dépôts et statistiques globales.
- **Recherche** : mots-clés (tous les termes doivent correspondre au titre, à la description, aux étiquettes ou au nom du fichier) et filtres par statut, workflow, déposant et période.
- **Historique** : chaque document garde la trace des dépôts, validations, rejets et commentaires.
- **Administration** : gestion des utilisateurs, des groupes (membres) et des workflows (éditeur d'étapes).

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

Variables d'environnement : `PORT` (défaut 3000) et `DATA_DIR` (défaut `./data`, contient la base SQLite et les fichiers).

## Tests

```bash
npm test
```

## Architecture

- `src/app.js` — API REST Express (authentification, utilisateurs, groupes, workflows, documents, tableau de bord, recherche).
- `src/db.js` — schéma SQLite et données de démonstration.
- `src/auth.js` — mots de passe (scrypt) et sessions par cookie.
- `public/` — interface web monopage en JavaScript natif.

## Pistes pour la suite

- Recherche plein texte dans le contenu des fichiers (extraction PDF/OCR, index FTS5).
- Versions de documents, dossiers/classement et métadonnées personnalisées par type de document.
- Notifications par courriel lors de l'assignation d'une étape ; délais et relances.
- Étapes parallèles ou conditionnelles, délégation et renvoi à l'étape précédente.
- Droits d'accès par document ou par dossier ; règles de conservation et d'archivage légal.
