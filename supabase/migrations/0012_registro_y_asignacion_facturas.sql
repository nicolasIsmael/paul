-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T016-T023 (Historia 1 e Historia 2): registro/validación de facturas y asignación manual a un
-- pool/tramo con anticipo. Ver contracts/registrar-factura.md y
-- contracts/asignar-factura-function.md.

-- T016-T017 (Historia 1): registrar_factura — resultado de negocio (aprobada/rechazada) devuelto
-- como jsonb, nunca como excepción, salvo para el rol incorrecto (PA008, sí es un error de la
-- llamada en sí). Idempotencia de duplicados por (proveedor, deudor, monto, fechas) — FR-003.
create or replace function public.registrar_factura (
  p_proveedor_nombre text,
  p_deudor_nombre text,
  p_deudor_sector public.sector_empresa,
  p_moneda public.moneda_soportada,
  p_monto_nominal numeric,
  p_fecha_emision date,
  p_fecha_vencimiento date
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_rol public.perfil_rol;
  v_proveedor_id uuid;
  v_deudor_id uuid;
  v_huella text;
  v_factura_id uuid;
begin
  select rol into v_rol from public.perfiles where id = (select auth.uid ());
  if v_rol is distinct from 'operador_banco' then
    raise exception 'Solo el operador de banco puede registrar facturas.' using errcode = 'PA008';
  end if;

  -- FR-002: coherencia simple. Resultado de negocio, no excepción — el operador puede seguir
  -- registrando otras facturas sin que la solicitud en sí falle.
  if p_monto_nominal is null or p_monto_nominal <= 0 then
    return jsonb_build_object(
      'estado_validacion', 'rechazada',
      'motivo_rechazo', 'PA014',
      'detalle', 'El monto debe ser positivo.'
    );
  end if;

  if p_fecha_vencimiento <= p_fecha_emision then
    return jsonb_build_object(
      'estado_validacion', 'rechazada',
      'motivo_rechazo', 'PA014',
      'detalle', 'La fecha de vencimiento debe ser posterior a la de emisión.'
    );
  end if;

  -- Proveedor/deudor: buscar por nombre exacto o crear la primera vez que se menciona.
  select id into v_proveedor_id from public.proveedores where nombre_comercial = p_proveedor_nombre;
  if not found then
    insert into public.proveedores (nombre_comercial) values (p_proveedor_nombre) returning id into v_proveedor_id;
  end if;

  select id into v_deudor_id from public.empresas_pagadoras where nombre_comercial = p_deudor_nombre;
  if not found then
    insert into public.empresas_pagadoras (nombre_comercial, sector)
    values (p_deudor_nombre, p_deudor_sector)
    returning id into v_deudor_id;
  end if;

  -- FR-003: duplicado exacto.
  if exists (
    select 1
    from public.facturas
    where
      proveedor_id = v_proveedor_id
      and empresa_id = v_deudor_id
      and monto_nominal = p_monto_nominal
      and fecha_emision = p_fecha_emision
      and fecha_vencimiento = p_fecha_vencimiento
  ) then
    return jsonb_build_object(
      'estado_validacion', 'rechazada',
      'motivo_rechazo', 'PA015',
      'detalle', 'Ya existe una factura registrada con estos mismos datos.'
    );
  end if;

  -- pgcrypto vive en el esquema `extensions` en este proyecto (no en `public`); con
  -- `search_path = ''` toda referencia debe ir calificada explícitamente.
  v_huella := encode(
    extensions.digest (
      v_proveedor_id::text || v_deudor_id::text || p_monto_nominal::text || p_moneda::text ||
      p_fecha_emision::text || p_fecha_vencimiento::text,
      'sha256'
    ),
    'hex'
  );

  insert into
    public.facturas (
      proveedor_id, empresa_id, moneda, monto_nominal, fecha_emision, fecha_vencimiento,
      huella_hash, estado_validacion
    )
  values
    (
      v_proveedor_id, v_deudor_id, p_moneda, p_monto_nominal, p_fecha_emision, p_fecha_vencimiento,
      v_huella, 'aprobada'
    )
  returning
    id
  into v_factura_id;

  return jsonb_build_object(
    'factura_id', v_factura_id,
    'estado_validacion', 'aprobada',
    'huella_hash', v_huella,
    'monto_nominal', p_monto_nominal
  );
end;
$$;

comment on function public.registrar_factura (
  text, text, public.sector_empresa, public.moneda_soportada, numeric, date, date
) is 'contracts/registrar-factura.md — FR-001..FR-005.';

revoke all on function public.registrar_factura (
  text, text, public.sector_empresa, public.moneda_soportada, numeric, date, date
)
from
  public,
  anon,
  authenticated;

grant
execute on function public.registrar_factura (
  text, text, public.sector_empresa, public.moneda_soportada, numeric, date, date
) to authenticated;

-- T018 (Historia 1, apoyo): única función de esta feature que expone proveedor_nombre/
-- deudor_nombre por fila — reservada al operador de banco (FR-021).
create or replace function public.listar_facturas_operador (
  p_estado_validacion public.estado_validacion_factura default null,
  p_estado_asignacion public.estado_asignacion_factura default null
) returns table (
  id uuid,
  proveedor_nombre text,
  deudor_nombre text,
  deudor_sector public.sector_empresa,
  moneda public.moneda_soportada,
  monto_nominal numeric,
  fecha_emision date,
  fecha_vencimiento date,
  estado_validacion public.estado_validacion_factura,
  motivo_rechazo text,
  estado_asignacion public.estado_asignacion_factura,
  estado_cobro public.estado_cobro_factura,
  pool_id uuid,
  tramo_id uuid,
  anticipo numeric
)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
begin
  if (select rol from public.perfiles where id = (select auth.uid ())) is distinct from 'operador_banco' then
    raise exception 'Solo el operador de banco puede listar facturas con datos identificables.' using errcode = 'PA008';
  end if;

  return query
  select
    f.id,
    pr.nombre_comercial,
    e.nombre_comercial,
    e.sector,
    f.moneda,
    f.monto_nominal,
    f.fecha_emision,
    f.fecha_vencimiento,
    f.estado_validacion,
    f.motivo_rechazo,
    f.estado_asignacion,
    f.estado_cobro,
    f.pool_id,
    f.tramo_id,
    f.anticipo
  from public.facturas f
  join public.proveedores pr on pr.id = f.proveedor_id
  join public.empresas_pagadoras e on e.id = f.empresa_id
  where
    (p_estado_validacion is null or f.estado_validacion = p_estado_validacion)
    and (p_estado_asignacion is null or f.estado_asignacion = p_estado_asignacion)
  order by f.fecha_emision desc;
end;
$$;

comment on function public.listar_facturas_operador (
  public.estado_validacion_factura, public.estado_asignacion_factura
) is 'contracts/registrar-factura.md — soporte de Historia 1/2. Única función que expone proveedor/deudor por fila.';

revoke all on function public.listar_facturas_operador (
  public.estado_validacion_factura, public.estado_asignacion_factura
)
from
  public,
  anon,
  authenticated;

grant
execute on function public.listar_facturas_operador (
  public.estado_validacion_factura, public.estado_asignacion_factura
) to authenticated;

-- T020-T021 (Historia 2): asignar_factura_a_pool — SOLO service_role, invocada por la Edge
-- Function asignar-factura (mismo patrón restringido que reservar_aporte, spec previa). El
-- fraccionamiento sale del ACUMULADO de anticipos del tramo, nunca del monto individual de la
-- factura (research.md §6/§8).
create or replace function public.asignar_factura_a_pool (
  p_factura_id uuid,
  p_tramo_id uuid,
  p_anticipo numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_factura public.facturas;
  v_tramo public.tramos;
  v_unidad_minima numeric;
  v_nuevo_total numeric;
  v_fracciones_nuevas integer;
  v_nueva_reserva numeric;
  v_incremento_capital numeric;
  v_pool_id uuid;
begin
  select * into v_factura from public.facturas where id = p_factura_id;
  if not found then
    raise exception 'Factura no encontrada.' using errcode = 'PA016';
  end if;

  -- Idempotencia: la propia factura es la clave natural — un reintento con los mismos datos
  -- devuelve el estado ya alcanzado sin repetir la aritmética.
  if v_factura.estado_asignacion in ('pendiente_onchain', 'asignada') then
    if v_factura.tramo_id = p_tramo_id and v_factura.anticipo = p_anticipo then
      return jsonb_build_object(
        'factura_id', v_factura.id,
        'estado_asignacion', v_factura.estado_asignacion,
        'ya_existia', true
      );
    else
      raise exception 'La factura ya está asignada a otro pool/tramo.' using errcode = 'PA018';
    end if;
  end if;

  if v_factura.estado_validacion <> 'aprobada' then
    raise exception 'La factura no está aprobada.' using errcode = 'PA016';
  end if;

  if p_anticipo is null or p_anticipo <= 0 or p_anticipo > v_factura.monto_nominal then
    raise exception 'El anticipo debe ser mayor a cero y no superar el valor nominal de la factura.'
    using errcode = 'PA017';
  end if;

  select * into v_tramo from public.tramos where id = p_tramo_id;
  if not found then
    raise exception 'Tramo no encontrado.' using errcode = 'PA012';
  end if;

  select unidad_minima_aporte, id into v_unidad_minima, v_pool_id
  from public.pools
  where id = v_tramo.pool_id;

  v_nuevo_total := v_tramo.monto_financiado_acumulado + p_anticipo;
  v_fracciones_nuevas := floor(v_nuevo_total / v_unidad_minima);
  v_nueva_reserva := v_nuevo_total - (v_fracciones_nuevas * v_unidad_minima);
  v_incremento_capital := (v_fracciones_nuevas - v_tramo.fracciones_totales) * v_unidad_minima;

  update public.tramos
  set
    monto_financiado_acumulado = v_nuevo_total,
    reserva = v_nueva_reserva,
    fracciones_totales = v_fracciones_nuevas,
    capital_objetivo = capital_objetivo + v_incremento_capital
  where id = p_tramo_id;

  update public.facturas
  set
    estado_asignacion = 'pendiente_onchain',
    tramo_id = p_tramo_id,
    pool_id = v_pool_id,
    anticipo = p_anticipo
  where id = p_factura_id;

  return jsonb_build_object(
    'factura_id', p_factura_id,
    'estado_asignacion', 'pendiente_onchain',
    'ya_existia', false,
    'huella_hash', v_factura.huella_hash,
    'fracciones_totales', v_fracciones_nuevas,
    'reserva', v_nueva_reserva,
    'pool_id', v_pool_id
  );
end;
$$;

revoke all on function public.asignar_factura_a_pool (uuid, uuid, numeric)
from
  public,
  anon,
  authenticated;

grant
execute on function public.asignar_factura_a_pool (uuid, uuid, numeric) to service_role;

-- T022: confirmar_asignacion_factura — SOLO service_role. Marca la asignación como definitiva e
-- irreversible (FR-012).
create or replace function public.confirmar_asignacion_factura (
  p_factura_id uuid,
  p_onchain_tx_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.facturas
  set estado_asignacion = 'asignada', onchain_tx_hash = p_onchain_tx_hash
  where id = p_factura_id and estado_asignacion = 'pendiente_onchain';
end;
$$;

revoke all on function public.confirmar_asignacion_factura (uuid, text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.confirmar_asignacion_factura (uuid, text) to service_role;

-- T023: revertir_asignacion_factura — SOLO service_role. Solo revierte mientras el estado es
-- 'pendiente_onchain' (una asignación 'asignada' es irreversible, FR-012). Recalcula a partir del
-- estado ACTUAL del tramo menos el anticipo de esta factura — correcto incluso si otras
-- asignaciones ocurrieron en el ínterin (research.md/contracts/asignar-factura-function.md).
create or replace function public.revertir_asignacion_factura (p_factura_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_factura public.facturas;
  v_tramo public.tramos;
  v_unidad_minima numeric;
  v_total_antes numeric;
  v_fracciones_antes integer;
  v_decremento_capital numeric;
begin
  select * into v_factura from public.facturas where id = p_factura_id and estado_asignacion = 'pendiente_onchain';
  if not found then
    return;
  end if;

  select * into v_tramo from public.tramos where id = v_factura.tramo_id;

  select unidad_minima_aporte into v_unidad_minima
  from public.pools
  where id = v_tramo.pool_id;

  v_total_antes := v_tramo.monto_financiado_acumulado - v_factura.anticipo;
  v_fracciones_antes := floor(v_total_antes / v_unidad_minima);
  v_decremento_capital := (v_tramo.fracciones_totales - v_fracciones_antes) * v_unidad_minima;

  update public.tramos
  set
    monto_financiado_acumulado = v_total_antes,
    reserva = v_total_antes - (v_fracciones_antes * v_unidad_minima),
    fracciones_totales = v_fracciones_antes,
    capital_objetivo = capital_objetivo - v_decremento_capital
  where id = v_factura.tramo_id;

  update public.facturas
  set estado_asignacion = 'sin_asignar', tramo_id = null, pool_id = null, anticipo = null
  where id = p_factura_id;
end;
$$;

revoke all on function public.revertir_asignacion_factura (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.revertir_asignacion_factura (uuid) to service_role;
