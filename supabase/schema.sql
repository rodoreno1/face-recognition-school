-- ============================================================================
-- Control de acceso CBTis 002 — esquema para Supabase.
--
-- Pégalo completo en el SQL Editor de tu proyecto y ejecútalo. Se puede volver
-- a ejecutar sin problema: no borra datos.
--
-- Cuentas y roles:
--   * La primera cuenta que se registra se vuelve administrador.
--   * Las demás quedan "pendiente" (sin acceso) hasta que un administrador les
--     asigne el rol desde la app (Configuración → Cuentas).
--   * admin  : administra alumnos, registros, configuración y cuentas.
--   * kiosco : solo lee alumnos y configuración y agrega registros (la caseta).
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------- Tablas ----------------------------------------------------------

create table if not exists public.perfiles (
  id      uuid primary key references auth.users(id) on delete cascade,
  correo  text,
  rol     text not null default 'pendiente' check (rol in ('admin', 'kiosco', 'pendiente')),
  creado  timestamptz not null default now()
);

create table if not exists public.config (
  id                  int primary key default 1 check (id = 1),
  plantel             text not null default 'CBTis 002',
  entrada_matutino    time not null default '07:00',
  entrada_vespertino  time not null default '13:30',
  tolerancia_min      int  not null default 10,
  umbral              real not null default 0.5,   -- distancia máxima para aceptar un rostro
  margen              real not null default 0.06,  -- ventaja mínima sobre el segundo candidato
  cooldown_seg        int  not null default 60,
  confirmaciones      int  not null default 3,
  sonido              boolean not null default true,
  actualizado         timestamptz not null default now()
);
insert into public.config (id) values (1) on conflict (id) do nothing;

create table if not exists public.alumnos (
  id            uuid primary key default gen_random_uuid(),
  matricula     text not null unique,
  nombre        text not null,
  grupo         text not null default '',
  semestre      text not null default '1',
  turno         text not null default 'Matutino' check (turno in ('Matutino', 'Vespertino')),
  foto          text,                              -- JPEG pequeño en data URL
  descriptores  jsonb not null default '[]'::jsonb, -- lista de vectores de 128 números
  activo        boolean not null default true,
  creado        timestamptz not null default now(),
  actualizado   timestamptz not null default now()
);
create index if not exists alumnos_grupo on public.alumnos (grupo);

create table if not exists public.registros (
  id              bigint generated always as identity primary key,
  alumno_id       uuid references public.alumnos(id) on delete cascade,
  nombre          text, matricula text, grupo text, turno text,  -- copia para el historial
  tipo            text not null check (tipo in ('entrada', 'salida')),
  ts              timestamptz not null default now(),
  fecha           date not null,                  -- fecha local del plantel (la manda la app)
  retardo         boolean not null default false,
  origen          text not null default 'facial' check (origen in ('facial', 'manual')),
  distancia       real,
  registrado_por  uuid default auth.uid()
);
create index if not exists registros_fecha on public.registros (fecha);
create index if not exists registros_alumno_fecha on public.registros (alumno_id, fecha);

-- ---------- Funciones y disparadores ---------------------------------------

create or replace function public.tocar_actualizado() returns trigger
language plpgsql as $$
begin
  new.actualizado = now();
  return new;
end $$;
drop trigger if exists t_alumnos_actualizado on public.alumnos;
create trigger t_alumnos_actualizado before update on public.alumnos
  for each row execute function public.tocar_actualizado();

-- Cada cuenta nueva recibe un perfil: la primera es administrador.
create or replace function public.al_crear_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfiles (id, correo, rol)
  values (new.id, new.email,
          case when exists (select 1 from public.perfiles where rol = 'admin')
               then 'pendiente' else 'admin' end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists t_al_crear_usuario on auth.users;
create trigger t_al_crear_usuario after insert on auth.users
  for each row execute function public.al_crear_usuario();

-- Rol de quien hace la petición. security definer evita que las políticas de
-- perfiles se consulten a sí mismas.
create or replace function public.rol_actual() returns text
language sql stable security definer set search_path = public as $$
  select rol from public.perfiles where id = auth.uid()
$$;

-- La pantalla de acceso lo usa (sin sesión) para ofrecer crear al primer admin.
create or replace function public.hay_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where rol = 'admin')
$$;

grant execute on function public.rol_actual() to authenticated;
grant execute on function public.hay_admin() to anon, authenticated;

-- ---------- Seguridad por renglón (RLS) -------------------------------------

alter table public.perfiles  enable row level security;
alter table public.config    enable row level security;
alter table public.alumnos   enable row level security;
alter table public.registros enable row level security;

drop policy if exists "perfil propio"        on public.perfiles;
drop policy if exists "admin ve perfiles"    on public.perfiles;
drop policy if exists "admin cambia roles"   on public.perfiles;
create policy "perfil propio"      on public.perfiles for select to authenticated using (id = auth.uid());
create policy "admin ve perfiles"  on public.perfiles for select to authenticated using (public.rol_actual() = 'admin');
create policy "admin cambia roles" on public.perfiles for update to authenticated
  using (public.rol_actual() = 'admin') with check (public.rol_actual() = 'admin');

drop policy if exists "config lectura" on public.config;
drop policy if exists "config admin"   on public.config;
create policy "config lectura" on public.config for select to authenticated using (public.rol_actual() in ('admin', 'kiosco'));
create policy "config admin"   on public.config for update to authenticated
  using (public.rol_actual() = 'admin') with check (public.rol_actual() = 'admin');

drop policy if exists "alumnos lectura" on public.alumnos;
drop policy if exists "alumnos admin"   on public.alumnos;
create policy "alumnos lectura" on public.alumnos for select to authenticated using (public.rol_actual() in ('admin', 'kiosco'));
create policy "alumnos admin"   on public.alumnos for all to authenticated
  using (public.rol_actual() = 'admin') with check (public.rol_actual() = 'admin');

drop policy if exists "registros lectura"  on public.registros;
drop policy if exists "registros insertar" on public.registros;
drop policy if exists "registros admin"    on public.registros;
create policy "registros lectura"  on public.registros for select to authenticated using (public.rol_actual() in ('admin', 'kiosco'));
create policy "registros insertar" on public.registros for insert to authenticated with check (public.rol_actual() in ('admin', 'kiosco'));
create policy "registros admin"    on public.registros for delete to authenticated using (public.rol_actual() = 'admin');

-- ---------- Tiempo real (el panel y el kiosco se actualizan solos) ----------

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'registros') then
    alter publication supabase_realtime add table public.registros;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alumnos') then
    alter publication supabase_realtime add table public.alumnos;
  end if;
end $$;
