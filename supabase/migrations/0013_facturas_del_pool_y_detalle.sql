-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T044-T047 (Historia 4 e Historia 5): facturas anonimizadas de un pool, extensión de
-- detalle_pool con margen_plazo_dias/estado_facturas, y el único punto de escritura del estado de
-- cobro de una factura. Ver contracts/facturas-del-pool.md.

-- T044: facturas_del_pool — nunca proyecta nombre_comercial de proveedor ni deudor (FR-019..021).
create or replace function public.facturas_del_pool (p_pool_id uuid) returns table (
  factura_id uuid,
  monto_nominal numeric,
  moneda public.moneda_soportada,
  sector public.sector_empresa,
  fecha_vencimiento date,
  dias_plazo integer,
  estado_cobro public.estado_cobro_factura
)
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select
    f.id,
    f.monto_nominal,
    f.moneda,
    e.sector,
    f.fecha_vencimiento,
    (f.fecha_vencimiento - f.fecha_emision)::integer,
    f.estado_cobro
  from public.facturas f
  join public.empresas_pagadoras e on e.id = f.empresa_id
  where f.pool_id = p_pool_id and f.estado_asignacion = 'asignada'
  order by f.fecha_vencimiento asc;
$$;

comment on function public.facturas_del_pool (uuid) is
  'contracts/facturas-del-pool.md — FR-019..FR-022. Nunca selecciona nombre_comercial de proveedor ni deudor.';

revoke all on function public.facturas_del_pool (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.facturas_del_pool (uuid) to authenticated;

-- T045: extensión de detalle_pool — agrega margen_plazo_dias y estado_facturas (agregado en
-- vivo, nunca un cálculo de rendimiento). CREATE OR REPLACE sobre la versión ya corregida en
-- 0011 (que solo arregló el rename operaciones->facturas, sin campos nuevos todavía).
create or replace function public.detalle_pool (p_pool_id uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_pool public.pools;
  v_senior public.tramos;
  v_junior public.tramos;
  v_num_operaciones integer;
  v_num_empresas integer;
  v_sectores public.sector_empresa[];
  v_max_operacion numeric;
  v_total_operaciones numeric;
  v_concentracion_maxima_pct numeric;
  v_tasa public.tipos_cambio_referencia;
  v_equivalente_xlm numeric;
  v_colchon_junior_pct numeric;
  v_pendientes integer;
  v_cobradas integer;
  v_en_mora integer;
  v_monto_cobrado numeric;
  v_pct_cobrado numeric;
begin
  select * into v_pool from public.pools where id = p_pool_id;
  if not found then
    raise exception 'Pool no encontrado (PA012).' using errcode = 'PA012';
  end if;

  select * into v_senior from public.tramos where pool_id = p_pool_id and tipo = 'senior';
  select * into v_junior from public.tramos where pool_id = p_pool_id and tipo = 'junior';

  select
    count(*),
    count(distinct o.empresa_id),
    array_agg(distinct e.sector order by e.sector),
    max(o.monto_nominal),
    sum(o.monto_nominal)
  into
    v_num_operaciones, v_num_empresas, v_sectores, v_max_operacion, v_total_operaciones
  from public.facturas o
  join public.empresas_pagadoras e on e.id = o.empresa_id
  where o.pool_id = p_pool_id;

  v_concentracion_maxima_pct := case
    when coalesce(v_total_operaciones, 0) > 0 then round(v_max_operacion / v_total_operaciones * 100, 1)
    else 0
  end;

  v_colchon_junior_pct := round(
    v_junior.capital_objetivo / (v_senior.capital_objetivo + v_junior.capital_objetivo) * 100, 1
  );

  select * into v_tasa from public.tipo_cambio_vigente (v_pool.moneda);
  if v_tasa.tasa_moneda_por_xlm is not null then
    v_equivalente_xlm := round(v_pool.unidad_minima_aporte / v_tasa.tasa_moneda_por_xlm, 7);
  end if;

  -- FR-023..FR-026: hechos agregados de estado de cobro, calculados en vivo sobre las facturas
  -- ya asignadas del pool — nunca una cifra de rendimiento, retorno ni dividendo (SC-008).
  select
    count(*) filter (where estado_cobro = 'pendiente'),
    count(*) filter (where estado_cobro = 'cobrada'),
    count(*) filter (where estado_cobro = 'en_mora'),
    coalesce(sum(monto_nominal) filter (where estado_cobro = 'cobrada'), 0)
  into
    v_pendientes, v_cobradas, v_en_mora, v_monto_cobrado
  from public.facturas
  where pool_id = p_pool_id and estado_asignacion = 'asignada';

  v_pct_cobrado := case
    when coalesce(v_total_operaciones, 0) > 0 then round(v_monto_cobrado / v_total_operaciones * 100, 1)
    else 0
  end;

  return jsonb_build_object(
    'id', v_pool.id,
    'nombre', v_pool.nombre,
    'descripcion_corta', v_pool.descripcion_corta,
    'moneda', v_pool.moneda,
    'plazo_dias', v_pool.plazo_dias,
    'fecha_vencimiento_esperada', v_pool.fecha_vencimiento_esperada,
    'margen_plazo_dias', v_pool.margen_plazo_dias,
    'perfil_riesgo', v_pool.perfil_riesgo,
    'perfil_riesgo_explicacion', v_pool.perfil_riesgo_explicacion,
    'estado', v_pool.estado,
    'composicion', jsonb_build_object(
      'numero_operaciones', coalesce(v_num_operaciones, 0),
      'numero_empresas', coalesce(v_num_empresas, 0),
      'sectores', to_jsonb(coalesce(v_sectores, array[]::public.sector_empresa[])),
      'concentracion_maxima_pct', v_concentracion_maxima_pct
    ),
    'estado_facturas', jsonb_build_object(
      'pendientes', coalesce(v_pendientes, 0),
      'cobradas', coalesce(v_cobradas, 0),
      'en_mora', coalesce(v_en_mora, 0),
      'pct_cobrado', v_pct_cobrado
    ),
    'tramos', jsonb_build_object(
      'senior', jsonb_build_object(
        'capital_objetivo', v_senior.capital_objetivo,
        'capital_comprometido', v_senior.capital_comprometido,
        'avance_pct', round(v_senior.capital_comprometido / v_senior.capital_objetivo * 100, 1),
        'cupo_disponible', v_senior.capital_objetivo - v_senior.capital_comprometido,
        'rendimiento_ilustrativo_plazo_pct', v_senior.rendimiento_ilustrativo_plazo_pct,
        'rendimiento_ilustrativo_anualizado_pct', v_senior.rendimiento_ilustrativo_anualizado_pct
      ),
      'junior', jsonb_build_object(
        'capital_objetivo', v_junior.capital_objetivo,
        'capital_comprometido', v_junior.capital_comprometido,
        'avance_pct', round(v_junior.capital_comprometido / v_junior.capital_objetivo * 100, 1),
        'cupo_disponible', v_junior.capital_objetivo - v_junior.capital_comprometido,
        'rendimiento_ilustrativo_plazo_pct', v_junior.rendimiento_ilustrativo_plazo_pct,
        'rendimiento_ilustrativo_anualizado_pct', v_junior.rendimiento_ilustrativo_anualizado_pct
      )
    ),
    'colchon_junior_pct', v_colchon_junior_pct,
    'aporte_minimo', jsonb_build_object(
      'moneda', v_pool.moneda,
      'monto', v_pool.unidad_minima_aporte,
      'equivalente_xlm', v_equivalente_xlm,
      'tipo_cambio_disponible', v_tasa.tasa_moneda_por_xlm is not null
    ),
    'comparacion_tramos', jsonb_build_object(
      'senior', format(
        'Si una empresa pagadora no paga, el tramo junior absorbe la pérdida primero (hasta %s%% del pool). El tramo senior solo se ve afectado si las pérdidas superan ese colchón — por eso su rendimiento ilustrativo es menor.',
        v_colchon_junior_pct
      ),
      'junior', 'Si una empresa pagadora no paga, el tramo junior es el primero en absorber la pérdida, antes que el senior — a cambio de un rendimiento ilustrativo mayor, asume más riesgo.'
    ),
    'disclaimer_rendimiento', 'Rendimiento ilustrativo, sin garantía, en red de pruebas.'
  );
end;
$$;

comment on function public.detalle_pool (uuid) is
  'Detalle agregado de un pool (FR-013..FR-019, FR-023..FR-026). contracts/detalle-pool.md, contracts/facturas-del-pool.md.';

revoke all on function public.detalle_pool (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.detalle_pool (uuid) to authenticated;

-- T047 (Historia 5): único punto de escritura de facturas.estado_cobro.
create or replace function public.actualizar_estado_cobro_factura (
  p_factura_id uuid,
  p_nuevo_estado public.estado_cobro_factura
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select rol from public.perfiles where id = (select auth.uid ())) is distinct from 'operador_banco' then
    raise exception 'Solo el operador de banco puede actualizar el estado de cobro de una factura.' using errcode = 'PA008';
  end if;

  if not exists (
    select 1 from public.facturas where id = p_factura_id and estado_asignacion = 'asignada'
  ) then
    raise exception 'La factura no existe o todavía no está asignada a un pool.' using errcode = 'PA016';
  end if;

  update public.facturas set estado_cobro = p_nuevo_estado where id = p_factura_id;
end;
$$;

comment on function public.actualizar_estado_cobro_factura (uuid, public.estado_cobro_factura) is
  'contracts/facturas-del-pool.md — soporte de Historia 5 (FR-024..FR-026).';

revoke all on function public.actualizar_estado_cobro_factura (uuid, public.estado_cobro_factura)
from
  public,
  anon,
  authenticated;

grant
execute on function public.actualizar_estado_cobro_factura (uuid, public.estado_cobro_factura) to authenticated;
