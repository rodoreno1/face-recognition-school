-- ============================================================================
-- CBTis 002 access control — Supabase schema.
--
-- Paste the whole file into the SQL Editor of your project and run it. It is
-- safe to run again: it never deletes data. If the previous Spanish schema
-- (alumnos / registros / config / perfiles) is present, its data is copied
-- into the new tables and the old tables are dropped.
--
-- Accounts and roles:
--   * The first account that signs up becomes an admin.
--   * Every other account is "pending" (no access) until an admin assigns a
--     role from the app (Configuración → Cuentas).
--   * admin : manages students, attendance records, settings and accounts.
--   * kiosk : only reads students and settings and inserts attendance records
--             (the entrance gate screen).
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------- Tables -----------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  role        text not null default 'pending' check (role in ('admin', 'kiosk', 'pending')),
  created_at  timestamptz not null default now()
);

create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  school_name           text not null default 'CBTis 002',
  morning_entry_time    time not null default '07:00',
  afternoon_entry_time  time not null default '13:30',
  tolerance_minutes     int  not null default 10,
  match_threshold       real not null default 0.5,   -- max face distance to accept a match
  match_margin          real not null default 0.06,  -- min lead over the second-best candidate
  cooldown_seconds      int  not null default 60,
  confirmations         int  not null default 3,
  sound_enabled         boolean not null default true,
  updated_at            timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.students (
  id              uuid primary key default gen_random_uuid(),
  student_number  text not null unique,
  full_name       text not null,
  group_name      text not null default '',
  semester        text not null default '1',
  shift           text not null default 'morning' check (shift in ('morning', 'afternoon')),
  photo           text,                              -- small JPEG as a data URL
  descriptors     jsonb not null default '[]'::jsonb, -- list of 128-float face vectors
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists students_group_name_idx on public.students (group_name);

create table if not exists public.attendance_records (
  id              bigint generated always as identity primary key,
  student_id      uuid references public.students(id) on delete cascade,
  full_name       text, student_number text, group_name text, shift text,  -- snapshot for history
  type            text not null check (type in ('entry', 'exit')),
  recorded_at     timestamptz not null default now(),
  record_date     date not null,                  -- local date at the school (sent by the app)
  late            boolean not null default false,
  source          text not null default 'face' check (source in ('face', 'manual')),
  distance        real,
  recorded_by     uuid default auth.uid()
);
create index if not exists attendance_records_record_date_idx on public.attendance_records (record_date);
create index if not exists attendance_records_student_date_idx on public.attendance_records (student_id, record_date);

-- ---------- Functions and triggers ------------------------------------------

create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists students_set_updated_at on public.students;
create trigger students_set_updated_at before update on public.students
  for each row execute function public.set_updated_at();

-- Every new auth user gets a profile; the first one is the admin.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email,
          case when exists (select 1 from public.profiles where role = 'admin')
               then 'pending' else 'admin' end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role of the caller. security definer keeps the profiles policies from
-- querying themselves.
create or replace function public.current_user_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- The sign-in screen calls this (without a session) to offer creating the
-- first admin.
create or replace function public.has_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where role = 'admin')
$$;

grant execute on function public.current_user_role() to authenticated;
grant execute on function public.has_admin() to anon, authenticated;

-- ---------- Row level security ----------------------------------------------

alter table public.profiles           enable row level security;
alter table public.settings           enable row level security;
alter table public.students           enable row level security;
alter table public.attendance_records enable row level security;

drop policy if exists "profiles: read own"        on public.profiles;
drop policy if exists "profiles: admin reads all" on public.profiles;
drop policy if exists "profiles: admin updates"   on public.profiles;
create policy "profiles: read own"        on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles: admin reads all" on public.profiles for select to authenticated using (public.current_user_role() = 'admin');
create policy "profiles: admin updates"   on public.profiles for update to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "settings: read"         on public.settings;
drop policy if exists "settings: admin writes" on public.settings;
create policy "settings: read"         on public.settings for select to authenticated using (public.current_user_role() in ('admin', 'kiosk'));
create policy "settings: admin writes" on public.settings for update to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "students: read"         on public.students;
drop policy if exists "students: admin writes" on public.students;
create policy "students: read"         on public.students for select to authenticated using (public.current_user_role() in ('admin', 'kiosk'));
create policy "students: admin writes" on public.students for all to authenticated
  using (public.current_user_role() = 'admin') with check (public.current_user_role() = 'admin');

drop policy if exists "attendance: read"          on public.attendance_records;
drop policy if exists "attendance: insert"        on public.attendance_records;
drop policy if exists "attendance: admin deletes" on public.attendance_records;
create policy "attendance: read"          on public.attendance_records for select to authenticated using (public.current_user_role() in ('admin', 'kiosk'));
create policy "attendance: insert"        on public.attendance_records for insert to authenticated with check (public.current_user_role() in ('admin', 'kiosk'));
create policy "attendance: admin deletes" on public.attendance_records for delete to authenticated using (public.current_user_role() = 'admin');

-- ---------- Migration from the previous Spanish schema ----------------------
-- Copies whatever exists in alumnos / registros / config / perfiles and then
-- drops them. Does nothing when those tables are not present.

do $$
begin
  if to_regclass('public.perfiles') is not null then
    insert into public.profiles (id, email, role, created_at)
      select id, correo,
             case rol when 'admin' then 'admin' when 'kiosco' then 'kiosk' else 'pending' end,
             creado
      from public.perfiles
      on conflict (id) do update set role = excluded.role, email = coalesce(excluded.email, public.profiles.email);
  end if;

  if to_regclass('public.config') is not null then
    update public.settings s
       set school_name = c.plantel, morning_entry_time = c.entrada_matutino,
           afternoon_entry_time = c.entrada_vespertino, tolerance_minutes = c.tolerancia_min,
           match_threshold = c.umbral, match_margin = c.margen, cooldown_seconds = c.cooldown_seg,
           confirmations = c.confirmaciones, sound_enabled = c.sonido
      from public.config c
     where s.id = 1 and c.id = 1;
  end if;

  if to_regclass('public.alumnos') is not null then
    insert into public.students (id, student_number, full_name, group_name, semester, shift, photo, descriptors, active, created_at, updated_at)
      select id, matricula, nombre, grupo, semestre,
             case turno when 'Vespertino' then 'afternoon' else 'morning' end,
             foto, descriptores, activo, creado, actualizado
      from public.alumnos
      on conflict (id) do nothing;
  end if;

  if to_regclass('public.registros') is not null then
    insert into public.attendance_records (student_id, full_name, student_number, group_name, shift, type, recorded_at, record_date, late, source, distance, recorded_by)
      select alumno_id, nombre, matricula, grupo,
             case turno when 'Vespertino' then 'afternoon' else 'morning' end,
             case tipo when 'salida' then 'exit' else 'entry' end,
             ts, fecha, retardo,
             case origen when 'manual' then 'manual' else 'face' end,
             distancia, registrado_por
      from public.registros
      order by id;
  end if;

  drop trigger if exists t_al_crear_usuario on auth.users;
  drop table if exists public.registros, public.alumnos, public.config, public.perfiles;
  drop function if exists public.rol_actual(), public.hay_admin(), public.al_crear_usuario(), public.tocar_actualizado();
end $$;

-- Accounts created before this script ran (if any) also need a profile.
insert into public.profiles (id, email, role)
  select u.id, u.email, 'pending' from auth.users u
  where not exists (select 1 from public.profiles p where p.id = u.id);
update public.profiles set role = 'admin'
  where id = (select id from public.profiles order by created_at limit 1)
    and not exists (select 1 from public.profiles where role = 'admin');

-- ---------- Realtime (the dashboard and the kiosk update by themselves) -----

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'attendance_records') then
    alter publication supabase_realtime add table public.attendance_records;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'students') then
    alter publication supabase_realtime add table public.students;
  end if;
end $$;
