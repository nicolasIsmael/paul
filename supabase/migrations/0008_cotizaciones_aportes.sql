-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T028-T033 (Historia 4): cotizaciones y aportes — el corazón de la feature. Ver data-model.md
-- (ciclo de vida del Aporte) y research.md §1 (mecanismo de concurrencia). T037 (Historia 5,
-- mis_posiciones()) se agrega a este mismo archivo más abajo, en una fase posterior.
--
-- Convención de errores con datos extra: igual que 0007_saldo_demostracion.sql, se adjuntan como
-- JSON en el DETAIL de la excepción (expuesto por PostgREST como `error.details`).

-- T028: cotizaciones.
create table public.cotizaciones (
  id uuid primary key default gen_random_uuid (),
  investor_id uuid not null references auth.users (id),
  pool_id uuid not null references public.pools (id),
  tramo_id uuid not null references public.tramos (id),
  monto_nominal numeric(14, 2) not null check (monto_nominal > 0),
  moneda public.moneda_soportada not null,
  tipo_cambio_aplicado numeric(18, 7) not null,
  monto_xlm numeric(20, 7) not null,
  generado_at timestamptz not null default now(),
  expira_at timestamptz not null default (now() + interval '5 minutes'),
  usada boolean not null default false
);

comment on table public.cotizaciones is
  'Propuesta de conversión monto->XLM, válida 5 minutos (Clarifications de spec.md). Es la tasa que se aplica si se confirma (FR-024).';

alter table public.cotizaciones enable row level security;

revoke all on public.cotizaciones
from
  anon,
  authenticated;

-- T029: aportes — estados reservado -> confirmado | revertido.
create type public.estado_aporte as enum ('reservado', 'confirmado', 'revertido');

create type public.motivo_reversion_aporte as enum (
  'xlm_insuficiente',
  'fallo_red_stellar',
  'reserva_vencida',
  'otro'
);

create table public.aportes (
  id uuid primary key default gen_random_uuid (),
  investor_id uuid not null references auth.users (id),
  pool_id uuid not null references public.pools (id),
  tramo_id uuid not null references public.tramos (id),
  cotizacion_id uuid not null references public.cotizaciones (id),
  idempotency_key uuid not null,
  monto_nominal numeric(14, 2) not null,
  moneda public.moneda_soportada not null,
  tipo_cambio_aplicado numeric(18, 7) not null,
  xlm_pagados numeric(20, 7),
  estado public.estado_aporte not null default 'reservado',
  tx_hash text,
  comprobante_simulado boolean not null default false,
  motivo_reversion public.motivo_reversion_aporte,
  reservado_at timestamptz not null default now(),
  expira_reserva_at timestamptz not null default (now() + interval '2 minutes'),
  confirmado_at timestamptz,
  revertido_at timestamptz,
  constraint aportes_investor_idempotency_unico unique (investor_id, idempotency_key)
);

comment on table public.aportes is
  'Registro de cada intento de aporte. El cupo/saldo se comprometen en estado=reservado (ver reservar_aporte) para que nunca se pueda sobrevender un tramo mid-pago.';

create index idx_aportes_reservados_vigencia on public.aportes (estado, expira_reserva_at)
where
  estado = 'reservado';

create index idx_aportes_investor_estado on public.aportes (investor_id, estado);

alter table public.aportes enable row level security;

revoke all on public.aportes
from
  anon,
  authenticated;

-- T030: cotizar_aporte — valida todo lo que puede validarse antes de reservar (Historia 4, primer
-- paso). No reserva cupo ni saldo (eso ocurre recién en reservar_aporte, ver más abajo).
create or replace function public.cotizar_aporte (
  p_pool_id uuid,
  p_tramo_tipo public.tipo_tramo,
  p_monto numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_investor_id uuid := (select auth.uid ());
  v_rol public.perfil_rol;
  v_wallet_lista boolean;
  v_pool public.pools;
  v_tramo public.tramos;
  v_tasa public.tipos_cambio_referencia;
  v_saldo numeric;
  v_cupo_disponible numeric;
  v_monto_xlm numeric;
  v_cotizacion_id uuid;
begin
  select rol, wallet_public_key is not null
  into v_rol, v_wallet_lista
  from public.perfiles
  where id = v_investor_id;

  if v_rol is distinct from 'inversionista' then
    raise exception 'Solo cuentas de inversionista pueden cotizar un aporte.' using errcode = 'PA008';
  end if;

  if not v_wallet_lista then
    raise exception 'La billetera todavía se está creando; puedes seguir explorando pools mientras tanto.'
    using errcode = 'PA007';
  end if;

  select * into v_pool from public.pools where id = p_pool_id;
  if not found then
    raise exception 'Pool no encontrado.' using errcode = 'PA012';
  end if;

  select * into v_tramo from public.tramos where pool_id = p_pool_id and tipo = p_tramo_tipo;
  if not found then
    raise exception 'Tramo no encontrado.' using errcode = 'PA012';
  end if;

  if v_pool.estado <> 'abierto' then
    raise exception 'El pool ya no admite aportes (estado: %).', v_pool.estado using errcode = 'PA006';
  end if;

  if p_monto is null or p_monto <= 0 or mod(p_monto, v_pool.unidad_minima_aporte) <> 0 then
    raise exception 'El monto debe ser múltiplo de la unidad mínima de aporte de este pool (%).',
      v_pool.unidad_minima_aporte
    using
      errcode = 'PA001',
      detail = jsonb_build_object('unidad_minima_aporte', v_pool.unidad_minima_aporte)::text;
  end if;

  select * into v_tasa from public.tipo_cambio_vigente (v_pool.moneda);
  if v_tasa.tasa_moneda_por_xlm is null then
    raise exception 'Tipo de cambio de referencia no disponible en este momento.' using errcode = 'PA010';
  end if;

  select coalesce(saldo, 0) into v_saldo
  from public.saldos_demostracion
  where investor_id = v_investor_id and moneda = v_pool.moneda;

  if coalesce(v_saldo, 0) < p_monto then
    raise exception 'Saldo de demostración insuficiente en %.', v_pool.moneda
    using
      errcode = 'PA002',
      detail = jsonb_build_object('saldo_disponible', coalesce(v_saldo, 0))::text;
  end if;

  v_cupo_disponible := v_tramo.capital_objetivo - v_tramo.capital_comprometido;
  if p_monto > v_cupo_disponible then
    raise exception 'El monto excede el cupo disponible del tramo.'
    using
      errcode = 'PA003',
      detail = jsonb_build_object('cupo_disponible', v_cupo_disponible)::text;
  end if;

  v_monto_xlm := round(p_monto / v_tasa.tasa_moneda_por_xlm, 7);

  insert into
    public.cotizaciones (
      investor_id, pool_id, tramo_id, monto_nominal, moneda, tipo_cambio_aplicado, monto_xlm
    )
  values
    (v_investor_id, p_pool_id, v_tramo.id, p_monto, v_pool.moneda, v_tasa.tasa_moneda_por_xlm, v_monto_xlm)
  returning
    id
  into v_cotizacion_id;

  return jsonb_build_object(
    'cotizacion_id', v_cotizacion_id,
    'pool_id', p_pool_id,
    'tramo_tipo', p_tramo_tipo,
    'monto_nominal', p_monto,
    'moneda', v_pool.moneda,
    'tipo_cambio_aplicado', v_tasa.tasa_moneda_por_xlm,
    'tipo_cambio_marca_tiempo', v_tasa.vigente_desde,
    'tipo_cambio_nota', v_tasa.nota,
    'monto_xlm', v_monto_xlm,
    'expira_at', (select expira_at from public.cotizaciones where id = v_cotizacion_id)
  );
end;
$$;

comment on function public.cotizar_aporte (uuid, public.tipo_tramo, numeric) is
  'contracts/cotizar-aporte.md — FR-020..FR-023.';

revoke all on function public.cotizar_aporte (uuid, public.tipo_tramo, numeric)
from
  public,
  anon,
  authenticated;

grant
execute on function public.cotizar_aporte (uuid, public.tipo_tramo, numeric) to authenticated;

-- T031: reservar_aporte — SOLO service_role, invocada por la Edge Function confirmar-aporte.
-- Libera reservas vencidas primero, luego compromete cupo+saldo de forma atómica en una sola
-- transacción (research.md §1). Idempotente por (investor_id, idempotency_key): FR-027.
create or replace function public.reservar_aporte (
  p_cotizacion_id uuid,
  p_investor_id uuid,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_existente public.aportes;
  v_cot public.cotizaciones;
  v_saldo numeric;
  v_tramo_actualizado public.tramos;
begin
  -- Libera reservas vencidas antes de continuar (ciclo de vida del Aporte, data-model.md).
  update public.tramos t
  set capital_comprometido = capital_comprometido - a.monto_nominal
  from public.aportes a
  where
    a.tramo_id = t.id
    and a.estado = 'reservado'
    and a.expira_reserva_at < now();

  update public.saldos_demostracion s
  set saldo = saldo + a.monto_nominal
  from public.aportes a
  where
    a.investor_id = s.investor_id
    and a.moneda = s.moneda
    and a.estado = 'reservado'
    and a.expira_reserva_at < now();

  update public.aportes
  set estado = 'revertido', motivo_reversion = 'reserva_vencida', revertido_at = now()
  where estado = 'reservado' and expira_reserva_at < now();

  -- Idempotencia: si esta solicitud ya se procesó, devolver su resultado actual sin repetir nada.
  select * into v_existente from public.aportes where investor_id = p_investor_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('aporte_id', v_existente.id, 'estado', v_existente.estado, 'ya_existia', true);
  end if;

  select * into v_cot from public.cotizaciones where id = p_cotizacion_id and investor_id = p_investor_id;
  if not found then
    raise exception 'Cotización no encontrada.' using errcode = 'PA005';
  end if;

  if v_cot.usada then
    raise exception 'Esta cotización ya fue utilizada.' using errcode = 'PA005';
  end if;

  if v_cot.expira_at < now() then
    raise exception 'La cotización expiró.' using errcode = 'PA004';
  end if;

  if (select estado from public.pools where id = v_cot.pool_id) <> 'abierto' then
    raise exception 'El pool ya no admite aportes.' using errcode = 'PA006';
  end if;

  select coalesce(saldo, 0) into v_saldo
  from public.saldos_demostracion
  where investor_id = p_investor_id and moneda = v_cot.moneda;

  if coalesce(v_saldo, 0) < v_cot.monto_nominal then
    raise exception 'Saldo de demostración insuficiente.' using errcode = 'PA002';
  end if;

  -- Garantía central de concurrencia (research.md §1): UPDATE condicional de una sola sentencia.
  update public.tramos
  set capital_comprometido = capital_comprometido + v_cot.monto_nominal
  where id = v_cot.tramo_id and capital_comprometido + v_cot.monto_nominal <= capital_objetivo
  returning * into v_tramo_actualizado;

  if not found then
    raise exception 'El monto excede el cupo disponible del tramo.' using errcode = 'PA003';
  end if;

  update public.saldos_demostracion
  set saldo = saldo - v_cot.monto_nominal, updated_at = now()
  where investor_id = p_investor_id and moneda = v_cot.moneda;

  update public.cotizaciones set usada = true where id = p_cotizacion_id;

  insert into
    public.aportes (
      investor_id, pool_id, tramo_id, cotizacion_id, idempotency_key, monto_nominal, moneda,
      tipo_cambio_aplicado
    )
  values
    (
      p_investor_id, v_cot.pool_id, v_cot.tramo_id, p_cotizacion_id, p_idempotency_key,
      v_cot.monto_nominal, v_cot.moneda, v_cot.tipo_cambio_aplicado
    )
  returning
    *
  into v_existente;

  return jsonb_build_object(
    'aporte_id', v_existente.id,
    'estado', v_existente.estado,
    'ya_existia', false,
    'monto_xlm', v_cot.monto_xlm,
    'pool_id', v_cot.pool_id,
    'tramo_id', v_cot.tramo_id
  );
end;
$$;

revoke all on function public.reservar_aporte (uuid, uuid, uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.reservar_aporte (uuid, uuid, uuid) to service_role;

-- T032: confirmar_aporte — SOLO service_role. No vuelve a tocar cupo ni saldo (ya comprometidos
-- en reservar_aporte).
create or replace function public.confirmar_aporte (
  p_aporte_id uuid,
  p_tx_hash text,
  p_simulado boolean default false
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.aportes
  set
    estado = 'confirmado',
    xlm_pagados = (select monto_xlm from public.cotizaciones where id = cotizacion_id),
    tx_hash = p_tx_hash,
    comprobante_simulado = p_simulado,
    confirmado_at = now()
  where id = p_aporte_id and estado = 'reservado';
end;
$$;

revoke all on function public.confirmar_aporte (uuid, text, boolean)
from
  public,
  anon,
  authenticated;

grant
execute on function public.confirmar_aporte (uuid, text, boolean) to service_role;

-- T033: revertir_aporte — SOLO service_role. Libera el cupo del tramo y devuelve el saldo demo.
create or replace function public.revertir_aporte (p_aporte_id uuid, p_motivo public.motivo_reversion_aporte) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aporte public.aportes;
begin
  select * into v_aporte from public.aportes where id = p_aporte_id and estado = 'reservado';
  if not found then
    return;
  end if;

  update public.tramos
  set capital_comprometido = capital_comprometido - v_aporte.monto_nominal
  where id = v_aporte.tramo_id;

  update public.saldos_demostracion
  set saldo = saldo + v_aporte.monto_nominal, updated_at = now()
  where investor_id = v_aporte.investor_id and moneda = v_aporte.moneda;

  update public.aportes
  set estado = 'revertido', motivo_reversion = p_motivo, revertido_at = now()
  where id = p_aporte_id;
end;
$$;

revoke all on function public.revertir_aporte (uuid, public.motivo_reversion_aporte)
from
  public,
  anon,
  authenticated;

grant
execute on function public.revertir_aporte (uuid, public.motivo_reversion_aporte) to service_role;

-- T035 (soporte): la Edge Function confirmar-aporte necesita la llave privada de la billetera del
-- inversionista para firmar el pago — mismo patrón wrapper que obtener_shared_secret_webhook()
-- (0002_wallet_provisioning.sql), ya que `vault` no es un esquema expuesto por PostgREST.
create or replace function public.obtener_secreto_wallet (perfil_id uuid) returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where id = (select wallet_secret_id from public.perfiles where id = perfil_id);
$$;

revoke all on function public.obtener_secreto_wallet (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_secreto_wallet (uuid) to service_role;

-- T037 (Historia 5): mis_posiciones — exclusivamente las posiciones del propio auth.uid(), sin
-- parámetro de identidad (FR-036). Solo aportes confirmados (data-model.md — reservado/revertido
-- nunca son una posición real).
create or replace function public.mis_posiciones () returns table (
  aporte_id uuid,
  pool_id uuid,
  pool_nombre text,
  pool_estado public.estado_pool,
  tramo_tipo public.tipo_tramo,
  monto_nominal numeric,
  moneda public.moneda_soportada,
  xlm_pagados numeric,
  tipo_cambio_aplicado numeric,
  confirmado_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    a.pool_id,
    p.nombre,
    p.estado,
    t.tipo,
    a.monto_nominal,
    a.moneda,
    a.xlm_pagados,
    a.tipo_cambio_aplicado,
    a.confirmado_at
  from public.aportes a
  join public.pools p on p.id = a.pool_id
  join public.tramos t on t.id = a.tramo_id
  where a.investor_id = (select auth.uid ()) and a.estado = 'confirmado'
  order by a.confirmado_at desc;
$$;

comment on function public.mis_posiciones () is
  'contracts/mis-posiciones.md — FR-035, FR-036. Siempre auth.uid(), nunca un parámetro de identidad.';

revoke all on function public.mis_posiciones ()
from
  public,
  anon,
  authenticated;

grant
execute on function public.mis_posiciones () to authenticated;
