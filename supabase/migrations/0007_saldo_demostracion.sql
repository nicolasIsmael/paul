-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T018-T021 (Historia 3): saldo de demostración (crédito off-chain en soles/dólares, nunca en
-- XLM — Clarifications de spec.md) y su recarga con tope diario compartido entre monedas.
--
-- Convención de errores con datos extra: cuando un error necesita datos estructurados además del
-- mensaje (p. ej. cuánto cupo queda), se adjuntan como JSON en el DETAIL de la excepción
-- (`using errcode = '...', detail = jsonb_build_object(...)::text`) — PostgREST expone esto como
-- `error.details`, parseable por el cliente. Ver data-model.md → Registro de códigos de error.

create table public.saldos_demostracion (
  investor_id uuid not null references auth.users (id) on delete cascade,
  moneda public.moneda_soportada not null,
  saldo numeric(14, 2) not null default 0 check (saldo >= 0),
  updated_at timestamptz not null default now(),
  primary key (investor_id, moneda)
);

comment on table public.saldos_demostracion is
  'Crédito de demostración por inversionista y moneda; no representa dinero real (FR-008). Solo se modifica vía funciones RPC, nunca directo.';

alter table public.saldos_demostracion enable row level security;

revoke all on public.saldos_demostracion
from
  anon,
  authenticated;

create table public.recargas_saldo (
  id uuid primary key default gen_random_uuid (),
  investor_id uuid not null references auth.users (id),
  moneda public.moneda_soportada not null,
  monto numeric(14, 2) not null check (monto > 0),
  monto_equivalente_soles numeric(14, 2) not null,
  tipo_cambio_referencia_aplicado numeric(18, 7),
  created_at timestamptz not null default now()
);

comment on table public.recargas_saldo is
  'Registro de cada recarga de demostración (FR-006), usado para computar el tope diario compartido entre monedas.';

create index idx_recargas_saldo_investor_dia on public.recargas_saldo (
  investor_id,
  (
    (created_at at time zone 'America/Lima')::date
  )
);

alter table public.recargas_saldo enable row level security;

revoke all on public.recargas_saldo
from
  anon,
  authenticated;

-- T020: consulta del saldo vigente (FR-002).
create or replace function public.mi_saldo_demostracion () returns table (moneda public.moneda_soportada, saldo numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select s.moneda, s.saldo
  from public.saldos_demostracion s
  where s.investor_id = (select auth.uid ());
$$;

comment on function public.mi_saldo_demostracion () is 'contracts/saldo-demostracion.md';

revoke all on function public.mi_saldo_demostracion ()
from
  public,
  anon,
  authenticated;

grant
execute on function public.mi_saldo_demostracion () to authenticated;

-- T021: recarga con tope diario de S/1000 (o equivalente en USD) por día natural en hora de
-- Lima, compartido entre monedas, seguro ante recargas simultáneas (pg_advisory_xact_lock por
-- inversionista+día — research.md §1). La recarga NO mueve XLM en la red (FR-003).
create or replace function public.recargar_saldo_demo (p_moneda public.moneda_soportada, p_monto numeric) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_investor_id uuid := (select auth.uid ());
  v_rol public.perfil_rol;
  v_wallet_lista boolean;
  v_dia_lima date := ((now() at time zone 'America/Lima')::date);
  v_tope_soles constant numeric := 1000.00;
  v_tasa_usd public.tipos_cambio_referencia;
  v_tasa_pen public.tipos_cambio_referencia;
  v_monto_equivalente_soles numeric;
  v_tipo_cambio_aplicado numeric;
  v_recargado_hoy numeric;
  v_disponible numeric;
  v_se_reinicia_at timestamptz := (((v_dia_lima + 1)::timestamp) at time zone 'America/Lima');
  v_nuevo_saldo numeric;
begin
  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto a recargar debe ser mayor a cero.' using errcode = 'PA001';
  end if;

  select rol, wallet_public_key is not null
  into v_rol, v_wallet_lista
  from public.perfiles
  where id = v_investor_id;

  if v_rol is distinct from 'inversionista' then
    raise exception 'Solo cuentas de inversionista pueden recargar saldo de demostración.'
    using errcode = 'PA008';
  end if;

  if not v_wallet_lista then
    raise exception 'La billetera todavía se está creando; puedes seguir explorando pools mientras tanto.'
    using errcode = 'PA007';
  end if;

  -- Serializa únicamente las recargas del mismo inversionista en el mismo día Lima — no bloquea
  -- a otros inversionistas entre sí (research.md §1).
  perform pg_advisory_xact_lock (hashtextextended (v_investor_id::text || ':' || v_dia_lima::text, 0));

  if p_moneda = 'PEN' then
    v_monto_equivalente_soles := p_monto;
    v_tipo_cambio_aplicado := null;
  else
    select * into v_tasa_usd from public.tipo_cambio_vigente ('USD');
    select * into v_tasa_pen from public.tipo_cambio_vigente ('PEN');
    if v_tasa_usd.tasa_moneda_por_xlm is null or v_tasa_pen.tasa_moneda_por_xlm is null then
      raise exception 'Tipo de cambio de referencia no disponible en este momento.'
      using errcode = 'PA010';
    end if;
    v_tipo_cambio_aplicado := v_tasa_usd.tasa_moneda_por_xlm;
    -- monto_usd -> XLM -> soles, vía las dos tasas de referencia vigentes.
    v_monto_equivalente_soles := round(
      p_monto / v_tasa_usd.tasa_moneda_por_xlm * v_tasa_pen.tasa_moneda_por_xlm, 2
    );
  end if;

  select coalesce(sum(monto_equivalente_soles), 0)
  into v_recargado_hoy
  from public.recargas_saldo
  where
    investor_id = v_investor_id
    and (created_at at time zone 'America/Lima')::date = v_dia_lima;

  v_disponible := v_tope_soles - v_recargado_hoy;

  if v_monto_equivalente_soles > v_disponible then
    raise exception 'La recarga excede el tope diario de S/% (equivalente).', v_tope_soles
    using
      errcode = 'PA011',
      detail = jsonb_build_object(
        'disponible_para_recargar_hoy', greatest(v_disponible, 0),
        'tope_diario_equivalente_soles', v_tope_soles,
        'se_reinicia_at', v_se_reinicia_at
      )::text;
  end if;

  insert into
    public.saldos_demostracion (investor_id, moneda, saldo, updated_at)
  values
    (v_investor_id, p_moneda, p_monto, now())
  on conflict (investor_id, moneda) do update
  set
    saldo = public.saldos_demostracion.saldo + excluded.saldo,
    updated_at = now()
  returning
    saldo
  into v_nuevo_saldo;

  insert into
    public.recargas_saldo (
      investor_id, moneda, monto, monto_equivalente_soles, tipo_cambio_referencia_aplicado
    )
  values
    (v_investor_id, p_moneda, p_monto, v_monto_equivalente_soles, v_tipo_cambio_aplicado);

  return jsonb_build_object(
    'saldo_actualizado', v_nuevo_saldo,
    'moneda', p_moneda,
    'recargado_hoy_equivalente_soles', v_recargado_hoy + v_monto_equivalente_soles,
    'tope_diario_equivalente_soles', v_tope_soles,
    'disponible_para_recargar_hoy', v_tope_soles - (v_recargado_hoy + v_monto_equivalente_soles),
    'se_reinicia_at', v_se_reinicia_at
  );
end;
$$;

comment on function public.recargar_saldo_demo (public.moneda_soportada, numeric) is
  'contracts/saldo-demostracion.md — FR-003..FR-006, tope diario compartido (SC-008).';

revoke all on function public.recargar_saldo_demo (public.moneda_soportada, numeric)
from
  public,
  anon,
  authenticated;

grant
execute on function public.recargar_saldo_demo (public.moneda_soportada, numeric) to authenticated;
