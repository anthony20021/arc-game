# Arc Clue

Petit jeu temps reel a 2 joueurs, deployable sur Vercel sans serveur dedie.

## Architecture

- Vercel heberge l'app Vite/React.
- Supabase Realtime gere uniquement les rooms, la presence et le chat.
- Aucune table, aucune DB, aucun historique.

La partie est ephemere : si les deux joueurs quittent la room, son etat disparait.

## Configuration locale

1. Cree un projet Supabase.
2. Copie `.env.example` vers `.env.local`.
3. Renseigne `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. Lance :

```bash
npm install
npm run dev
```

## Deploiement Vercel

Ajoute les deux variables d'environnement dans Vercel :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Vercel detectera Vite automatiquement. La commande de build est :

```bash
npm run build
```

## Regles du MVP

Le joueur qui donne l'indice voit une position secrete sur le demi-cercle et propose un objet du theme qui correspond a son niveau d'amour. L'autre joueur place son curseur. Le score est calcule selon l'ecart :

- 3 points : tres proche
- 2 points : proche
- 1 point : correct
- 0 point : trop loin

## Diagnostic

Le panneau diagnostic Supabase est masque par defaut. Pour l'afficher, ouvre la
meme app avec `/dev` a la fin de l'URL, par exemple :

```text
http://localhost:5174/dev
```

## Reprise de partie

La derniere room, le role du joueur, l'etat de manche et la position secrete
locale sont sauvegardes dans le navigateur pendant 12 heures. Si un joueur
recharge ou ferme l'onglet par accident, il peut rouvrir l'app et rejoindre la
partie avec le meme navigateur.

Sans base de donnees, une reprise sur un autre appareil ou apres suppression du
stockage local n'est pas garantie.
