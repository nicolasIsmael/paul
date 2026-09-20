-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T003-T009: entidades fundacionales del dominio de inversión fraccionada — empresas pagadoras,
-- operaciones (facturas fraccionables), pools y tramos. Ver data-model.md para el detalle de cada
-- decisión. Ninguna de estas tablas concede privilegios a anon/authenticated: todo el acceso de
-- cliente pasa por funciones security definer (0009_catalogo_consultas.sql), nunca por PostgREST
-- directamente sobre estas tablas — así se garantiza, a nivel de base de datos, que el
-- inversionista nunca ve una operación ni una empresa individual (FR-014 de la spec).

-- T003: enums del dominio.
create type public.moneda_soportada as enum ('PEN', 'USD');

create type public.sector_empresa as enum (
  'retail',
  'manufactura',
  'servicios',
  'construccion',
  'tecnologia'
);

create type public.perfil_riesgo_pool as enum ('conservador', 'balanceado', 'agresivo');

create type public.estado_pool as enum ('abierto', 'fondeado', 'cerrado');

create type public.tipo_tramo as enum ('senior', 'junior');

-- T004: empresas pagadoras (ficticias, nunca expuestas individualmente al inversionista).
create table public.empresas_pagadoras (
  id uuid primary key default gen_random_uuid (),
  nombre_comercial text not null,
  sector public.sector_empresa not null,
  created_at timestamptz not null default now()
);

comment on table public.empresas_pagadoras is
  'Empresas ficticias cuyas facturas respaldan operaciones; solo se exponen de forma agregada (FR-014).';

-- T005: pools de inversión. custody_public_key/custody_secret_id quedan NULL hasta que
-- 0005_custodia_pools.sql aprovisione la cuenta de custodia dedicada del pool (mismo ciclo de
-- vida asíncrono que perfiles.wallet_public_key en la feature previa).
create table public.pools (
  id uuid primary key default gen_random_uuid (),
  codigo text not null unique,
  nombre text not null,
  descripcion_corta text not null,
  moneda public.moneda_soportada not null,
  plazo_dias integer not null check (plazo_dias in (30, 60, 90)),
  perfil_riesgo public.perfil_riesgo_pool not null,
  perfil_riesgo_explicacion text not null,
  fecha_apertura timestamptz not null default now(),
  fecha_vencimiento_esperada date not null,
  estado public.estado_pool not null default 'abierto',
  unidad_minima_aporte numeric(14, 2) not null check (unidad_minima_aporte > 0),
  custody_public_key text,
  custody_secret_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pools is
  'Pool de inversión fraccionada; una sola moneda, compuesto de tramo senior + junior (data-model.md).';

create trigger pools_set_updated_at
before update on public.pools
for each row
execute function public.set_updated_at (); -- reutiliza la función ya creada en 0001_perfiles.sql

-- T006: tramos — exactamente uno senior y uno junior por pool.
create table public.tramos (
  id uuid primary key default gen_random_uuid (),
  pool_id uuid not null references public.pools (id),
  tipo public.tipo_tramo not null,
  capital_objetivo numeric(14, 2) not null check (capital_objetivo > 0),
  capital_comprometido numeric(14, 2) not null default 0 check (
    capital_comprometido >= 0
    and capital_comprometido <= capital_objetivo
  ),
  rendimiento_ilustrativo_plazo_pct numeric(6, 3) not null,
  rendimiento_ilustrativo_anualizado_pct numeric(6, 3) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tramos_pool_tipo_unico unique (pool_id, tipo)
);

comment on table public.tramos is
  'Tramo senior/junior de un pool. capital_comprometido solo se modifica vía el UPDATE condicional atómico de reservar_aporte/revertir_aporte (research.md §1) — nunca desde el cliente.';

create trigger tramos_set_updated_at
before update on public.tramos
for each row
execute function public.set_updated_at ();

-- T007: operaciones (facturas fraccionables). Solo se cargan vía seed en esta feature — el flujo
-- de aprobación del operador está fuera de alcance.
create table public.operaciones (
  id uuid primary key default gen_random_uuid (),
  pool_id uuid not null references public.pools (id),
  empresa_id uuid not null references public.empresas_pagadoras (id),
  moneda public.moneda_soportada not null,
  monto_nominal numeric(14, 2) not null check (monto_nominal > 0),
  created_at timestamptz not null default now()
);

comment on table public.operaciones is
  'Factura fraccionable que compone un pool; jamás expuesta individualmente al inversionista (FR-014).';

-- FR-039: un pool solo agrupa operaciones de su propia moneda — reforzado a nivel de dato, no
-- solo de disciplina del seed.
create or replace function public.operaciones_moneda_coincide_pool ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.moneda is distinct from (select moneda from public.pools where id = new.pool_id) then
    raise exception 'La moneda de la operación debe coincidir con la moneda de su pool (FR-039).';
  end if;
  return new;
end;
$$;

create trigger operaciones_moneda_coincide_pool
before insert or update on public.operaciones
for each row
execute function public.operaciones_moneda_coincide_pool ();

-- T008: transición automática abierto -> fondeado cuando ambos tramos alcanzan su capital
-- objetivo (Clarifications de spec.md). Única vía de esta transición.
create or replace function public.tramos_actualiza_estado_pool ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pool_estado public.estado_pool;
  v_todos_llenos boolean;
begin
  select estado into v_pool_estado from public.pools where id = new.pool_id;

  if v_pool_estado <> 'abierto' then
    return new;
  end if;

  select bool_and(capital_comprometido = capital_objetivo)
  into v_todos_llenos
  from public.tramos
  where pool_id = new.pool_id;

  if v_todos_llenos then
    update public.pools set estado = 'fondeado' where id = new.pool_id;
  end if;

  return new;
end;
$$;

-- `insert or update`: un aporte real siempre llega vía UPDATE (reservar_aporte), pero un tramo
-- que ya nace en capital_objetivo (p. ej. datos de ejemplo) también debe disparar la transición.
create trigger tramos_actualiza_estado_pool
after insert or update of capital_comprometido on public.tramos
for each row
execute function public.tramos_actualiza_estado_pool ();

-- T009: RLS habilitada sin políticas (deny-all por defecto) + revoke explícito de privilegios de
-- tabla completa. Supabase concede SELECT/INSERT/UPDATE/DELETE de tabla completa a
-- anon/authenticated por defecto en toda tabla nueva de `public` — un `revoke` explícito es
-- obligatorio, no opcional (mismo hallazgo que research.md de la feature previa, §5). Todo acceso
-- de cliente pasa exclusivamente por catalogo_pools()/detalle_pool() (0009_catalogo_consultas.sql).
alter table public.empresas_pagadoras enable row level security;

alter table public.operaciones enable row level security;

alter table public.pools enable row level security;

alter table public.tramos enable row level security;

revoke all on public.empresas_pagadoras
from
  anon,
  authenticated;

revoke all on public.operaciones
from
  anon,
  authenticated;

revoke all on public.pools
from
  anon,
  authenticated;

revoke all on public.tramos
from
  anon,
  authenticated;
