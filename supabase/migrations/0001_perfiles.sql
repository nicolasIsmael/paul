-- Feature: Registro, Inicio de Sesión y Perfil de Usuario (specs/20260919-131233-auth-perfil-usuario)
-- T004-T008: tabla perfiles, constraint, updated_at, RLS, privilegios de columna.
-- Ver data-model.md y research.md §5 para el detalle de cada decisión.

-- T004: enum de rol + tabla perfiles (1:1 con auth.users)
create type public.perfil_rol as enum ('inversionista', 'operador_banco');

create table public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  rol public.perfil_rol not null, -- siempre se fija en el propio signUp() (sin login social)
  nombre_completo text not null,
  telefono text,
  foto_url text,
  wallet_public_key text,
  wallet_secret_id uuid,
  es_cuenta_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- T005: wallet_public_key/wallet_secret_id solo pueden existir para inversionistas
  constraint wallet_fields_solo_inversionista check (
    rol = 'inversionista' or (wallet_public_key is null and wallet_secret_id is null)
  )
);

comment on table public.perfiles is
  'Perfil 1:1 con auth.users; cubre inversionista y operador de banco (spec FR-002..FR-014).';

-- T006: updated_at automático
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger perfiles_set_updated_at
before update on public.perfiles
for each row
execute function public.set_updated_at();

-- T007: RLS — cada usuario solo ve/edita su propia fila; sin política de INSERT
-- (la única vía de creación es la función SECURITY DEFINER handle_new_user, ver 0002).
alter table public.perfiles enable row level security;

-- (select auth.uid()) en vez de auth.uid() a secas: evita que Postgres reevalúe la función por
-- cada fila (hallazgo de los Performance Advisors en T027) — patrón recomendado por Supabase.
create policy perfiles_select_own
on public.perfiles for select
to authenticated
using ((select auth.uid ()) = id);

create policy perfiles_update_own
on public.perfiles for update
to authenticated
using ((select auth.uid ()) = id)
with
check ((select auth.uid ()) = id);

-- T008: privilegios de columna — solo nombre_completo/telefono/foto_url son editables,
-- y wallet_secret_id nunca es legible vía la API pública (FR-011, FR-014).
--
-- IMPORTANTE: un REVOKE de columna por sí solo (p. ej. `revoke update (rol) ... from
-- authenticated`) NO basta, porque Supabase concede por defecto privilegios de TABLA completa a
-- `authenticated` en las tablas nuevas de `public`, y ese grant de tabla sigue permitiendo
-- actualizar/leer la columna aunque exista un revoke de columna (Postgres concede el privilegio
-- si cualquiera de los dos lo permite). El patrón correcto es revocar el privilegio de tabla
-- completo y conceder explícitamente solo las columnas permitidas (allow-list). Detectado y
-- corregido durante T018 (validación de Historia 1/3) contra el proyecto real — ver
-- research.md §5.
revoke select, update on public.perfiles
from authenticated;

grant select (
  id,
  rol,
  nombre_completo,
  telefono,
  foto_url,
  wallet_public_key,
  es_cuenta_demo,
  created_at,
  updated_at
) on public.perfiles to authenticated;

grant
update (nombre_completo, telefono, foto_url) on public.perfiles to authenticated;
