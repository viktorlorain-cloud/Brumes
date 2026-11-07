# Brumes

Jeu de colonisation au tour par tour pour téléphone : des expéditions découvrent une île cachée par la brume autour d'un vieux phare.

Version actuelle : prototype jouable à 2-4 joueurs, en ligne (chacun sur son téléphone) ou sur un seul téléphone.

## Jouer

**Lien à partager pour installer le jeu : https://viktorlorain-cloud.github.io/Brumes/telecharger/**
La page détecte l'appareil : APK sur Android, ajout à l'écran d'accueil sur iPhone, jeu dans le navigateur (et QR code) sur ordinateur.

L'appli est publiée automatiquement sur GitHub Pages à chaque modification de la branche `main` :
https://viktorlorain-cloud.github.io/Brumes/

- **Créer une partie en ligne** : donne un code de 4 lettres à envoyer aux amis.
- **Rejoindre** : saisir le code (ou ouvrir le lien d'invitation).
- **Partie locale** : on se passe le téléphone.
- **Installer** : iPhone, Safari › Partager › « Sur l'écran d'accueil ». Android, Chrome › ⋮ › « Installer l'application ».

## Comment c'est construit

| Fichier | Rôle |
| --- | --- |
| `src/engine.js` | Moteur de règles : état JSON, actions, événements. Aucune dépendance à l'affichage. |
| `src/view.js` | Plateau 3D (Three.js) et animations des éclaireurs. |
| `src/net.js` | Salons temps réel via Supabase Realtime (broadcast + présence). |
| `src/main.js` | Interface, salons, synchronisation, reprise d'une partie. |
| `public/` | Manifest, icônes et service worker de l'appli installable. |

Le téléphone de l'hôte arbitre la partie : il applique les actions et diffuse l'état à tous. Si l'hôte part, le joueur connecté le mieux placé reprend l'arbitrage. L'état est aussi gardé sur chaque téléphone pour reprendre après une coupure.

## Développer

```bash
npm install
npm run build        # construit dist/
npm run dev          # construit puis sert dist/ sur http://localhost:5173
```

Pour tester le multijoueur sans réseau, ouvrir deux onglets avec `?transport=bc&id=A` et `?transport=bc&id=B`.

## Limites connues

- Pas encore de carnets de bord, Grande Piste, Grande Escorte, échanges entre joueurs ni bots.
- Toutes les données de la partie arrivent sur chaque téléphone : pas de vrai secret entre joueurs.
- Le projet Supabase gratuit se met en pause après une semaine sans activité : le réactiver depuis le tableau de bord Supabase.
