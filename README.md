# Arc Clue

Petit jeu temps reel a 2 joueurs, deployable sur Vercel sans serveur dedie.

## Architecture

- Vercel heberge l'app Vite/React.
- Supabase Auth gere les comptes email/mot de passe.
- Supabase Postgres stocke les profils, themes, groupes de themes et amis.
- Supabase Realtime gere les rooms, la presence et le chat.

La partie live reste ephemere : si les deux joueurs quittent la room, son etat
disparait. Les comptes, amis et themes restent en base.

## Configuration locale

1. Cree un projet Supabase.
2. Dans le SQL editor Supabase, execute `supabase/schema.sql`.
3. Dans Auth > Providers > Email, desactive la confirmation email.
4. Copie `.env.example` vers `.env.local`.
5. Renseigne `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY`.
6. Renseigne aussi les variables serveur pour les actions admin :

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

7. Lance :

```bash
npm install
npm run dev
```

Pour creer le premier admin, cree d'abord ton compte depuis l'app, puis lance :

```sql
update public.profiles
set is_admin = true
where lower(username) = lower('ton-pseudo');
```

Depuis l'app, un admin peut aussi :

- creer un joueur ;
- passer un joueur admin ou le repasser joueur ;
- changer le mot de passe d'un joueur ;
- gerer les themes globaux.

## Deploiement Vercel

Ajoute les deux variables d'environnement dans Vercel :

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

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

La reprise de la room live utilise encore le stockage local du navigateur. Une
reprise sur un autre appareil ou apres suppression du stockage local n'est pas
garantie.
