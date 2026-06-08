create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(trim(username)) between 2 and 24),
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username));

create table if not exists public.themes (
  id bigserial primary key,
  label text not null check (char_length(trim(label)) between 2 and 60),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists themes_label_lower_key
  on public.themes (lower(label));

create table if not exists public.theme_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.theme_group_items (
  group_id uuid not null references public.theme_groups(id) on delete cascade,
  theme_id bigint not null references public.themes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, theme_id)
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> addressee_id)
);

create unique index if not exists friendships_unique_pair
  on public.friendships (
    least(requester_id, addressee_id),
    greatest(requester_id, addressee_id)
  );

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists themes_touch_updated_at on public.themes;
create trigger themes_touch_updated_at
  before update on public.themes
  for each row execute function public.touch_updated_at();

drop trigger if exists theme_groups_touch_updated_at on public.theme_groups;
create trigger theme_groups_touch_updated_at
  before update on public.theme_groups
  for each row execute function public.touch_updated_at();

drop trigger if exists friendships_touch_updated_at on public.friendships;
create trigger friendships_touch_updated_at
  before update on public.friendships
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'username'), ''),
      'joueur-' || substr(new.id::text, 1, 8)
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

with auth_profile_candidates as (
  select
    auth_users.id,
    auth_users.created_at,
    coalesce(
      nullif(trim(auth_users.raw_user_meta_data->>'username'), ''),
      'joueur-' || substr(auth_users.id::text, 1, 8)
    ) as base_username
  from auth.users as auth_users
  where not exists (
    select 1
    from public.profiles
    where profiles.id = auth_users.id
  )
),
numbered_candidates as (
  select
    *,
    row_number() over (
      partition by lower(base_username)
      order by created_at, id
    ) as duplicate_index
  from auth_profile_candidates
)
insert into public.profiles (id, username)
select
  id,
  case
    when duplicate_index = 1
      and not exists (
        select 1
        from public.profiles
        where lower(profiles.username) = lower(numbered_candidates.base_username)
      )
      then base_username
    else left(base_username, 19) || '-' || substr(id::text, 1, 4)
  end
from numbered_candidates
on conflict do nothing;

create or replace function public.is_admin(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select profiles.is_admin from public.profiles where profiles.id = user_id),
    false
  );
$$;

alter table public.profiles enable row level security;
alter table public.themes enable row level security;
alter table public.theme_groups enable row level security;
alter table public.theme_group_items enable row level security;
alter table public.friendships enable row level security;

drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "themes_read_authenticated" on public.themes;
create policy "themes_read_authenticated"
  on public.themes for select
  to authenticated
  using (true);

drop policy if exists "themes_admin_insert" on public.themes;
create policy "themes_admin_insert"
  on public.themes for insert
  to authenticated
  with check (public.is_admin(auth.uid()));

drop policy if exists "themes_admin_update" on public.themes;
create policy "themes_admin_update"
  on public.themes for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "themes_admin_delete" on public.themes;
create policy "themes_admin_delete"
  on public.themes for delete
  to authenticated
  using (public.is_admin(auth.uid()));

drop policy if exists "theme_groups_owner_select" on public.theme_groups;
create policy "theme_groups_owner_select"
  on public.theme_groups for select
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "theme_groups_owner_insert" on public.theme_groups;
create policy "theme_groups_owner_insert"
  on public.theme_groups for insert
  to authenticated
  with check (owner_id = auth.uid());

drop policy if exists "theme_groups_owner_update" on public.theme_groups;
create policy "theme_groups_owner_update"
  on public.theme_groups for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "theme_groups_owner_delete" on public.theme_groups;
create policy "theme_groups_owner_delete"
  on public.theme_groups for delete
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "theme_group_items_owner_select" on public.theme_group_items;
create policy "theme_group_items_owner_select"
  on public.theme_group_items for select
  to authenticated
  using (
    exists (
      select 1
      from public.theme_groups
      where theme_groups.id = theme_group_items.group_id
        and theme_groups.owner_id = auth.uid()
    )
  );

drop policy if exists "theme_group_items_owner_insert" on public.theme_group_items;
create policy "theme_group_items_owner_insert"
  on public.theme_group_items for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.theme_groups
      where theme_groups.id = theme_group_items.group_id
        and theme_groups.owner_id = auth.uid()
    )
  );

drop policy if exists "theme_group_items_owner_delete" on public.theme_group_items;
create policy "theme_group_items_owner_delete"
  on public.theme_group_items for delete
  to authenticated
  using (
    exists (
      select 1
      from public.theme_groups
      where theme_groups.id = theme_group_items.group_id
        and theme_groups.owner_id = auth.uid()
    )
  );

drop policy if exists "friendships_participant_select" on public.friendships;
create policy "friendships_participant_select"
  on public.friendships for select
  to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

drop policy if exists "friendships_request_insert" on public.friendships;
create policy "friendships_request_insert"
  on public.friendships for insert
  to authenticated
  with check (
    requester_id = auth.uid()
    and addressee_id <> auth.uid()
    and status = 'pending'
  );

drop policy if exists "friendships_accept_update" on public.friendships;
create policy "friendships_accept_update"
  on public.friendships for update
  to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid() and status = 'accepted');

drop policy if exists "friendships_participant_delete" on public.friendships;
create policy "friendships_participant_delete"
  on public.friendships for delete
  to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

revoke update on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant insert (id, username) on public.profiles to authenticated;
grant update (username, updated_at) on public.profiles to authenticated;

grant select, insert, update, delete on public.themes to authenticated;
grant usage, select on sequence public.themes_id_seq to authenticated;

grant select, insert, update, delete on public.theme_groups to authenticated;
grant select, insert, delete on public.theme_group_items to authenticated;
grant select, insert, update, delete on public.friendships to authenticated;
grant execute on function public.is_admin(uuid) to authenticated;
grant usage on schema public to authenticated;

insert into public.themes (label)
select seed.label
from (
  values
    ('Nourriture sucree'),
    ('Nourriture salee'),
    ('Plat maison'),
    ('Dessert'),
    ('Snack'),
    ('Fast food'),
    ('Saveur de glace'),
    ('Bonbon'),
    ('Boisson'),
    ('Sauce'),
    ('Fruit'),
    ('Fromage'),
    ('Pizza'),
    ('Burger'),
    ('Tacos'),
    ('Jeu video'),
    ('Chanteur'),
    ('Chanteuse'),
    ('Rappeur'),
    ('Couleur'),
    ('Parfum'),
    ('Style de musique'),
    ('Star ac'),
    ('Activite'),
    ('Boisson sans alcool'),
    ('Boisson alcoolisee'),
    ('Boisson chaude'),
    ('Legume'),
    ('Marque de vetements'),
    ('Ciao kombucha'),
    ('Matiere scolaire'),
    ('Serie'),
    ('Film'),
    ('Phrase'),
    ('Dessin anime')
) as seed(label)
where not exists (
  select 1
  from public.themes
  where lower(themes.label) = lower(seed.label)
);
