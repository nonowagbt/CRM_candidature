# CRM_candidature

CRM local pour suivre mes candidatures (stage, alternance, emploi).

## Lancer

```bash
npm start        # ou : node server.js
```

Puis ouvrir http://localhost:3000 (aucune dépendance à installer, Node ≥ 18).

## Fonctionnement

- Les données sont dans `data/candidatures.json` (créé au premier lancement à partir de `data/seed.json`).
  Ces deux fichiers sont exclus de git car ils contiennent des données personnelles.
- Statuts : Postulé · Réponse reçue · Entretien · Retenu · Refusé après entretien · Refusé sans entretien · Offre clôturée.
- Changer le statut directement dans le tableau remplit automatiquement la date de réponse ou d'entretien si elle est vide.
- ✉ ouvre le fil Gmail correspondant, ✎ modifie la candidature.
- Les entreprises en orange (« à compléter » / « à confirmer ») sont des candidatures Indeed dont l'entreprise n'apparaît pas dans l'email de confirmation.
- Export CSV (ouvrable dans Excel), sauvegarde/restauration JSON.

## ⚙️ Paramètres

Le bouton **⚙️** en haut à droite ouvre les paramètres, enregistrés dans `data/settings.json` (exclu de git, lisible par toi seul) :

- **Gmail** : adresse + [mot de passe d'application](https://myaccount.google.com/apppasswords) (validation en 2 étapes requise),
  avec un bouton **Tester la connexion**. Le mot de passe n'est jamais renvoyé à la page ; laisse le champ vide pour garder celui enregistré.
- **Profil** : nom d'expéditeur, titre et sous-titre de l'appli, paragraphe de présentation et signature utilisés dans les relances,
  délai avant le badge « ⏰ À relancer ».

`.env` (voir `.env.example`) reste accepté comme valeur par défaut, mais les Paramètres sont prioritaires.

## Relances → brouillons Gmail

Le bouton **↻** (cartes, liste, fiche) dépose une relance pré-rédigée dans **tes brouillons Gmail**, rattachée au fil d'origine
pour les candidatures envoyées par mail. Il ne reste qu'à relire et envoyer. Sans Gmail configuré, la relance s'ouvre pré-remplie dans Gmail.

## Sécurité

Le serveur n'écoute que sur `127.0.0.1` et refuse les appels venant d'un autre site (vérification de l'hôte, de l'origine et du type JSON).
