-- Feature: Liquidación de Tramo (Cobro Simulado, Camino Feliz)
-- (specs/20260925-002004-liquidacion-tramo)
-- Fix encontrado en conversación con la usuaria: cotizar_aporte/reservar_aporte
-- (0008_cotizaciones_aportes.sql) nunca revisaban tramos.estado_liquidacion — un inversionista
-- podía, en teoría, invertir en un tramo que ya le pagó a todos y ya quemó sus fracciones
-- (agregado por 0018_liquidacion_tramo.sql, posterior a 0008). Se corrige sin editar 0008 ya
-- aplicada, mismo patrón que 0004 sobre 0002 y el fix de digest sobre 0012. Reutiliza PA006
-- ("el pool/tramo ya no admite aportes") — mismo código, mensaje distinto según el caso.

-- cotizar_aporte: se agrega el chequeo justo después de encontrar el tramo, antes de cualquier
-- otra validación de monto/saldo/cupo — sin sentido cotizar algo que ya no se puede confirmar.
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

  -- Fix: un tramo ya liquidado (0018_liquidacion_tramo.sql) nunca vuelve a admitir aportes.
  if v_tramo.estado_liquidacion <> 'activo' then
    raise exception 'Este tramo ya fue liquidado y no admite nuevos aportes.' using errcode = 'PA006';
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

-- reservar_aporte: se agrega el mismo chequeo justo después de validar el estado del pool — cierra
-- la ventana entre "se cotizó antes de liquidar" y "se confirma después de liquidar".
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
  v_estado_liquidacion text;
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

  -- Fix: un tramo ya liquidado (0018_liquidacion_tramo.sql) nunca vuelve a admitir aportes,
  -- incluso si la cotización se generó antes de que se liquidara.
  select estado_liquidacion into v_estado_liquidacion from public.tramos where id = v_cot.tramo_id;
  if v_estado_liquidacion <> 'activo' then
    raise exception 'Este tramo ya fue liquidado y no admite nuevos aportes.' using errcode = 'PA006';
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
