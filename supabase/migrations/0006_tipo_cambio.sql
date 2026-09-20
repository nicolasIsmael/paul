-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T010: tipo de cambio de referencia XLM<->soles/dólares. Histórico append-only: nunca se hace
-- UPDATE de una fila existente, así cada cotización conserva exactamente la tasa que usó aunque
-- la tasa "vigente" cambie después. Convención de dirección (data-model.md): tasa_moneda_por_xlm
-- = cuántas unidades de la moneda equivalen a 1 XLM.

create table public.tipos_cambio_referencia (
  id uuid primary key default gen_random_uuid (),
  moneda public.moneda_soportada not null,
  tasa_moneda_por_xlm numeric(18, 7) not null check (tasa_moneda_por_xlm > 0),
  vigente_desde timestamptz not null default now(),
  nota text
);

comment on table public.tipos_cambio_referencia is
  'Parámetro de demostración (FR-037): sin valor de mercado real, rotulado explícitamente en cada respuesta que lo usa.';

create index idx_tipos_cambio_moneda_vigencia on public.tipos_cambio_referencia (moneda, vigente_desde desc);

alter table public.tipos_cambio_referencia enable row level security;

revoke all on public.tipos_cambio_referencia
from
  anon,
  authenticated;

-- Devuelve la tasa vigente (la más reciente) para una moneda, o ninguna fila si no hay ninguna
-- todavía (edge case: tipo de cambio no disponible -> PA010 en las funciones que la consumen).
create or replace function public.tipo_cambio_vigente (p_moneda public.moneda_soportada)
returns public.tipos_cambio_referencia
language sql
stable
set search_path = ''
as $$
  select *
  from public.tipos_cambio_referencia
  where moneda = p_moneda
  order by vigente_desde desc
  limit 1;
$$;

comment on function public.tipo_cambio_vigente (public.moneda_soportada) is
  'Función interna de solo lectura, usada por catalogo_pools/detalle_pool/cotizar_aporte/recargar_saldo_demo. No se expone vía RPC pública: revocada de public/anon/authenticated.';

revoke all on function public.tipo_cambio_vigente (public.moneda_soportada)
from
  public,
  anon,
  authenticated;
