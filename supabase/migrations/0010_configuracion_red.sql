-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T004-T006: tabla configuracion_red + wrappers de Vault. Mismo patrón exacto que
-- obtener_url_base_functions()/obtener_secreto_wallet() de las features previas — `vault` no es
-- un esquema expuesto por PostgREST ni alcanzable desde SQL fuera de una función que lo consulte
-- directamente. Ver research.md §1 y data-model.md → configuracion_red.

-- T004: una sola fila por red ('testnet' en este proyecto). La puebla el script de despliegue
-- (contracts/scripts/deploy.sh), nunca una migración ni el Dashboard.
create table public.configuracion_red (
  red text primary key,
  operador_authority_public_key text not null,
  operador_authority_secret_id uuid not null,
  token_wasm_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.configuracion_red is
  'Una fila por red Stellar (testnet). Poblada por contracts/scripts/deploy.sh — nunca a mano desde el Dashboard (Principio VII).';

create trigger configuracion_red_set_updated_at
before update on public.configuracion_red
for each row
execute function public.set_updated_at (); -- ya creada en 0001_perfiles.sql

alter table public.configuracion_red enable row level security;

revoke all on public.configuracion_red
from
  anon,
  authenticated;

-- T005: lectura de la parte pública (nunca el secreto) — únicamente service_role, invocada por
-- las Edge Functions que necesitan saber a qué WASM/autoridad corresponde cada instancia.
create or replace function public.obtener_configuracion_red (p_red text default 'testnet') returns table (
  operador_authority_public_key text,
  token_wasm_hash text
)
language sql
stable
security definer
set search_path = ''
as $$
  select operador_authority_public_key, token_wasm_hash
  from public.configuracion_red
  where red = p_red;
$$;

revoke all on function public.obtener_configuracion_red (text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_configuracion_red (text) to service_role;

-- T006: wrapper del secreto de la autoridad de plataforma — mismo patrón exacto que
-- obtener_secreto_wallet(uuid) (0008_cotizaciones_aportes.sql).
create or replace function public.obtener_secreto_autoridad_operador (p_red text default 'testnet') returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where id = (select operador_authority_secret_id from public.configuracion_red where red = p_red);
$$;

revoke all on function public.obtener_secreto_autoridad_operador (text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_secreto_autoridad_operador (text) to service_role;

-- Soporte de T034 (contracts/deploy-contrato.md): único punto de escritura de configuracion_red,
-- invocado una sola vez por contracts/scripts/deploy.sh (vía el cliente service_role de
-- Supabase). Idempotente: si la red ya tiene configuración, no hace nada — mismo patrón que
-- aprovisionar_custodia_pool (0005_custodia_pools.sql).
create or replace function public.registrar_configuracion_red (
  p_red text,
  p_operador_authority_public_key text,
  p_operador_authority_secret text,
  p_token_wasm_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if exists (select 1 from public.configuracion_red where red = p_red) then
    return;
  end if;

  select
    vault.create_secret (
      p_operador_authority_secret,
      'stellar_operador_authority_' || p_red
    ) into v_secret_id;

  insert into
    public.configuracion_red (
      red, operador_authority_public_key, operador_authority_secret_id, token_wasm_hash
    )
  values
    (p_red, p_operador_authority_public_key, v_secret_id, p_token_wasm_hash);
end;
$$;

revoke all on function public.registrar_configuracion_red (text, text, text, text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.registrar_configuracion_red (text, text, text, text) to service_role;
