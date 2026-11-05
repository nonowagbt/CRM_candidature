# CRM_candidature

CRM local pour suivre mes candidatures (stage, alternance, emploi).

## Lancer

```bash
npm start        # ou : node server.js
```

Puis ouvrir http://localhost:3000 (`npm install` d'abord, Node ≥ 18 — Node 20+ recommandé).

## Appli web (PWA)

Le CRM s'installe comme une vraie appli (icône, fenêtre à part, plein écran sur mobile) :

- **Ordinateur (Chrome / Edge)** : icône ⊕ dans la barre d'adresse, ou menu ⋯ → « 📲 Installer l'appli ».
- **Android (Chrome)** : bouton « Installer l'appli » sur la page de connexion / menu ⋯, ou menu Chrome → « Installer l'application ».
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ».
- Appui long sur l'icône installée : raccourcis « Nouvelle candidature » et « À relancer ».
- Hors ligne : l'interface reste disponible et un bandeau le signale ; les données, elles, restent sur le serveur (jamais mises en cache).
- L'installation exige **HTTPS** (ou `localhost`) : pour l'utiliser sur ton téléphone, le site doit être en ligne (voir plus bas).
- Les icônes se régénèrent avec `node scripts/make-icons.js`.

## Comptes

- Chaque personne crée son compte (email + mot de passe ≥ 8 caractères) sur la page de connexion.
- Chaque compte a **ses propres candidatures et ses propres paramètres** (Gmail, signature…), dans `data/users/<id>/`.
- Le **premier compte créé** récupère les données de l'ancienne version mono-utilisateur (`data/candidatures.json`, `data/settings.json`).
- Mot de passe changeable dans ⚙️ Paramètres → Mon compte (déconnecte les autres appareils).

## Mettre le site en ligne

1. Héberge-le derrière un proxy HTTPS (Caddy, Nginx, Render, Railway…).
2. Dans `.env` : `HOST=0.0.0.0`, `ALLOWED_HOSTS=ton-domaine.fr`, `COOKIE_SECURE=true`, et une `SECRET_KEY` fixe.
3. Sauvegarde régulièrement le dossier `data/` (comptes, candidatures, clé de chiffrement).
4. `ALLOW_SIGNUP=false` pour fermer les inscriptions une fois tes utilisateurs créés.

## Fonctionnement

- Toutes les données sont dans `data/` (exclu de git : données personnelles, mots de passe chiffrés, clé de chiffrement).
- Statuts : Postulé · Réponse reçue · Entretien · Retenu · Refusé après entretien · Refusé sans entretien · Offre clôturée.
- Changer le statut directement dans le tableau remplit automatiquement la date de réponse ou d'entretien si elle est vide.
- ✉ ouvre le fil Gmail correspondant, ✎ modifie la candidature.
- Les entreprises en orange (« à compléter » / « à confirmer ») sont des candidatures Indeed dont l'entreprise n'apparaît pas dans l'email de confirmation.
- Export CSV (ouvrable dans Excel), sauvegarde/restauration JSON.

## ⚙️ Paramètres

Le bouton **⚙️** en haut à droite ouvre les paramètres du compte connecté :

- **Gmail** : adresse + [mot de passe d'application](https://myaccount.google.com/apppasswords) (validation en 2 étapes requise),
  avec un bouton **Tester la connexion**. Le mot de passe est chiffré (AES-256-GCM) sur le serveur et n'est jamais renvoyé à la page ; laisse le champ vide pour garder celui enregistré.
- **Profil** : nom d'expéditeur, titre et sous-titre de l'appli, paragraphe de présentation et signature utilisés dans les relances,
  délai avant le badge « ⏰ À relancer ».

## 🔔 Centre de notifications

La cloche en haut à droite liste les derniers mails liés à tes candidatures, tirés de Gmail à chaque synchronisation
(recruteurs, sites carrière, **Indeed, LinkedIn, Hellowork, Welcome to the Jungle**…) :

- chaque mail est classé : **entretien proposé, réponse, refus, accusé de réception, offre clôturée**, ou relance envoyée ;
- il est rattaché à la bonne candidature (fil Gmail, adresse, ou nom de l'entreprise pour les plateformes) ;
- un bouton applique le **statut suggéré** (ex. « Passer en Refus sans entretien ») ;
- un mail non reconnu peut être **associé** à une candidature (ses prochains mails seront reconnus) ou servir à **créer** une candidature ;
- filtres : non lues, réponses & entretiens, refus, accusés de réception, à associer.

### 🔗 Plateformes (⚙️ Paramètres)

LinkedIn et Indeed ne proposent aucun accès aux candidatures pour une appli externe, et confier son mot de passe LinkedIn/Indeed
à un site tiers est contraire à leurs règles. La section **Plateformes** des paramètres :

- montre pour LinkedIn, Indeed, Hellowork et Welcome to the Jungle si le **suivi via Gmail** fonctionne (nombre de mails reçus, dernier reçu) ;
- donne les liens directs « Mes candidatures » et « Activer les emails » de chaque plateforme ;
- **importe l'historique LinkedIn** : LinkedIn → Préférences → *Obtenir une copie de vos données* → fichier `Jobs/Job Applications.csv`
  (les candidatures déjà présentes sont ignorées, même si l'intitulé diffère un peu).

## Relances → brouillons Gmail

Le bouton **↻** (cartes, liste, fiche) dépose une relance pré-rédigée dans **tes brouillons Gmail**, rattachée au fil d'origine
pour les candidatures envoyées par mail. Il ne reste qu'à relire et envoyer. Sans Gmail configuré, la relance s'ouvre pré-remplie dans Gmail.

## Sécurité

- Mots de passe des comptes hachés (scrypt), sessions par cookie `HttpOnly` / `SameSite=Lax` (+ `Secure` en HTTPS), jetons stockés hachés.
- Blocage 15 min après 8 échecs de connexion (par IP et par email).
- Appels venant d'un autre site refusés (hôte, origine, JSON obligatoire), en-têtes de sécurité (CSP, anti-iframe).
- Par défaut le serveur n'écoute que sur `127.0.0.1`.
