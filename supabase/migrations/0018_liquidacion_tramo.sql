-- Feature: Liquidación de Tramo (Cobro Simulado, Camino Feliz)
-- (specs/20260925-002004-liquidacion-tramo)
-- T002-T008: cierra el ciclo de inversión que hasta ahora terminaba en "el inversionista aporta y
-- recibe fracciones" sin ningún camino de vuelta. Ver contracts/liquidacion-rpcs.md y
-- data-model.md.
--
-- Registro de códigos de error (continúa desde PA020, spec de originación de facturas):
--   PA021 - el tramo no está en estado 'activo' (ya liquidando o liquidado)
--   PA022 - el tramo tiene al menos una factura asignada que no está 'cobrada'
--   PA023 - tramo inexistente
-- PA008 (rol no autorizado) se reutiliza tal cual, verificado por la Edge Function
-- `liquidar-tramo` antes de invocar cualquiera de estas funciones (mismo patrón que
-- asignar_factura_a_pool/reservar_aporte — estas funciones son service_role-only, sin repetir el
-- chequeo de auth.uid() aquí porque una llamada vía service_role no arrastra el JWT original).

-- T002: estado terminal de liquidación del tramo.
alter table public.tramos
  add column estado_liquidacion text not null default 'activo'
    check (estado_liquidacion in ('activo', 'liquidando', 'liquidado'));

comment on column public.tramos.estado_liquidacion is
  'activo -> liquidando -> liquidado (terminal). data-model.md — Liquidación de Tramo.';

-- T003: detalle por inversionista de cada liquidación — hecho histórico inmutable, sin updated_at.
create table public.liquidaciones_tramo_inversionista (
  id uuid primary key default gen_random_uuid(),
  tramo_id uuid not null references public.tramos(id),
  investor_id uuid not null references public.perfiles(id),
  fracciones integer not null check (fracciones >= 0),
  monto_pagado numeric(14, 2) not null check (monto_pagado >= 0),
  moneda text not null,
  tx_hash_pago text,
  tx_hash_quema text,
  estado text not null check (estado in ('pagado', 'compensado')),
  motivo_compensacion text,
  created_at timestamptz not null default now(),
  unique (tramo_id, investor_id)
);

comment on table public.liquidaciones_tramo_inversionista is
  'Detalle por inversionista de cada liquidación de tramo. La unique (tramo_id, investor_id) es lo
  que hace segura la reanudación de una liquidación interrumpida — ver plan.md → Riesgos.';

-- Sin políticas de RLS ni privilegios directos a anon/authenticated — todo acceso pasa por las
-- funciones security definer de abajo (mismo patrón que el resto del proyecto).
alter table public.liquidaciones_tramo_inversionista enable row level security;

revoke all on public.liquidaciones_tramo_inversionista from public, anon, authenticated;

-- T004: valida y arranca la liquidación; devuelve a quién hay que pagarle.
create or replace function public.iniciar_liquidacion_tramo(p_tramo_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_tramo public.tramos;
  v_facturas_pendientes uuid[];
begin
  select * into v_tramo from public.tramos where id = p_tramo_id for update;
  if not found then
    raise exception 'Tramo no encontrado.' using errcode = 'PA023';
  end if;

  if v_tramo.estado_liquidacion <> 'activo' then
    raise exception 'El tramo no está activo (estado actual: %).', v_tramo.estado_liquidacion
    using errcode = 'PA021';
  end if;

  -- FR-003: el 100% de las facturas asignadas a este tramo deben estar ya cobradas.
  select array_agg(id) into v_facturas_pendientes
  from public.facturas
  where tramo_id = p_tramo_id and estado_cobro <> 'cobrada';

  if v_facturas_pendientes is not null and array_length(v_facturas_pendientes, 1) > 0 then
    raise exception 'El tramo tiene facturas sin cobrar: %.', v_facturas_pendientes
    using errcode = 'PA022';
  end if;

  update public.tramos set estado_liquidacion = 'liquidando' where id = p_tramo_id;

  return jsonb_build_object(
    'tramo_id', p_tramo_id,
    'inversionistas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'investor_id', a.investor_id,
        'wallet_public_key', p.wallet_public_key
      )), '[]'::jsonb)
      from (
        select distinct a.investor_id
        from public.aportes a
        where a.tramo_id = p_tramo_id and a.estado = 'confirmado'
      ) a
      join public.perfiles p on p.id = a.investor_id
      where not exists (
        select 1 from public.liquidaciones_tramo_inversionista l
        where l.tramo_id = p_tramo_id and l.investor_id = a.investor_id
      )
    )
  );
end;
$$;

comment on function public.iniciar_liquidacion_tramo(uuid) is
  'contracts/liquidacion-rpcs.md — FR-001..FR-003, FR-009, FR-011.';

revoke all on function public.iniciar_liquidacion_tramo(uuid) from public, anon, authenticated;
grant execute on function public.iniciar_liquidacion_tramo(uuid) to service_role;

-- T005: registra un pago exitoso. on conflict do nothing protege contra una doble llamada
-- accidental de la Edge Function para el mismo inversionista.
create or replace function public.registrar_pago_liquidacion(
  p_tramo_id uuid,
  p_investor_id uuid,
  p_fracciones integer,
  p_monto numeric,
  p_moneda text,
  p_tx_pago text,
  p_tx_quema text
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.liquidaciones_tramo_inversionista
    (tramo_id, investor_id, fracciones, monto_pagado, moneda, tx_hash_pago, tx_hash_quema, estado)
  values
    (p_tramo_id, p_investor_id, p_fracciones, p_monto, p_moneda, p_tx_pago, p_tx_quema, 'pagado')
  on conflict (tramo_id, investor_id) do nothing;
$$;

revoke all on function public.registrar_pago_liquidacion(uuid, uuid, integer, numeric, text, text, text)
  from public, anon, authenticated;
grant execute on function public.registrar_pago_liquidacion(uuid, uuid, integer, numeric, text, text, text)
  to service_role;

-- T006: registra una compensación (FR-008) — el pago o la quema de este inversionista falló tras
-- reintentos y se revirtió lo que ya se le hubiera ejecutado.
create or replace function public.registrar_liquidacion_compensada(
  p_tramo_id uuid,
  p_investor_id uuid,
  p_fracciones integer,
  p_monto numeric,
  p_moneda text,
  p_motivo text,
  p_tx_hash_pago text default null,
  p_tx_hash_quema text default null
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.liquidaciones_tramo_inversionista
    (tramo_id, investor_id, fracciones, monto_pagado, moneda, tx_hash_pago, tx_hash_quema, estado,
     motivo_compensacion)
  values
    (p_tramo_id, p_investor_id, p_fracciones, p_monto, p_moneda, p_tx_hash_pago, p_tx_hash_quema,
     'compensado', p_motivo)
  on conflict (tramo_id, investor_id) do nothing;
$$;

revoke all on function public.registrar_liquidacion_compensada(
  uuid, uuid, integer, numeric, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.registrar_liquidacion_compensada(
  uuid, uuid, integer, numeric, text, text, text, text
) to service_role;

-- T007: cierra la liquidación de forma terminal (FR-010). El filtro por 'liquidando' evita marcar
-- 'liquidado' dos veces si la Edge Function se reintenta después de ya haber terminado.
create or replace function public.finalizar_liquidacion_tramo(p_tramo_id uuid) returns void
language sql
security definer
set search_path = ''
as $$
  update public.tramos
  set estado_liquidacion = 'liquidado'
  where id = p_tramo_id and estado_liquidacion = 'liquidando';
$$;

revoke all on function public.finalizar_liquidacion_tramo(uuid) from public, anon, authenticated;
grant execute on function public.finalizar_liquidacion_tramo(uuid) to service_role;
