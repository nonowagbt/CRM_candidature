# CRM_candidature

CRM local pour suivre mes candidatures (stage, alternance, emploi).

## Lancer

```bash
npm start        # ou : node server.js
```

Puis ouvrir http://localhost:3000 (`npm install` d'abord, Node ≥ 18 — Node 20+ recommandé).

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

## Relances → brouillons Gmail

Le bouton **↻** (cartes, liste, fiche) dépose une relance pré-rédigée dans **tes brouillons Gmail**, rattachée au fil d'origine
pour les candidatures envoyées par mail. Il ne reste qu'à relire et envoyer. Sans Gmail configuré, la relance s'ouvre pré-remplie dans Gmail.

## Sécurité

- Mots de passe des comptes hachés (scrypt), sessions par cookie `HttpOnly` / `SameSite=Lax` (+ `Secure` en HTTPS), jetons stockés hachés.
- Blocage 15 min après 8 échecs de connexion (par IP et par email).
- Appels venant d'un autre site refusés (hôte, origine, JSON obligatoire), en-têtes de sécurité (CSP, anti-iframe).
- Par défaut le serveur n'écoute que sur `127.0.0.1`.
