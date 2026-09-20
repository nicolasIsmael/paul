-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T011-T012 (Historia 1): catalogo_pools() — único punto de acceso de cliente al listado de
-- pools; agrega siempre desde tramos (nunca una columna denormalizada) y nunca expone una
-- operación o empresa individual. Ver contracts/catalogo-pools.md.
-- T015-T016 (Historia 2) agrega detalle_pool() a este mismo archivo más abajo.

create or replace function public.catalogo_pools (
  p_moneda public.moneda_soportada default null,
  p_plazo_dias integer default null,
  p_perfil_riesgo public.perfil_riesgo_pool default null,
  p_sector public.sector_empresa default null,
  p_estado public.estado_pool default null,
  p_orden text default 'avance_desc'
) returns table (
  id uuid,
  nombre text,
  moneda public.moneda_soportada,
  plazo_dias integer,
  perfil_riesgo public.perfil_riesgo_pool,
  estado public.estado_pool,
  capital_objetivo numeric,
  capital_comprometido numeric,
  avance_pct numeric,
  sectores public.sector_empresa[]
)
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  with agregado as (
    select
      p.id,
      p.nombre,
      p.moneda,
      p.plazo_dias,
      p.perfil_riesgo,
      p.estado,
      p.fecha_vencimiento_esperada,
      sum(tr.capital_objetivo) as capital_objetivo,
      sum(tr.capital_comprometido) as capital_comprometido
    from public.pools p
    join public.tramos tr on tr.pool_id = p.id
    where
      (p_moneda is null or p.moneda = p_moneda)
      and (p_plazo_dias is null or p.plazo_dias = p_plazo_dias)
      and (p_perfil_riesgo is null or p.perfil_riesgo = p_perfil_riesgo)
      and (p_estado is null or p.estado = p_estado)
      and (
        p_sector is null
        or exists (
          select 1
          from public.operaciones o
          join public.empresas_pagadoras e on e.id = o.empresa_id
          where o.pool_id = p.id and e.sector = p_sector
        )
      )
    group by p.id, p.nombre, p.moneda, p.plazo_dias, p.perfil_riesgo, p.estado, p.fecha_vencimiento_esperada
  )
  select
    a.id,
    a.nombre,
    a.moneda,
    a.plazo_dias,
    a.perfil_riesgo,
    a.estado,
    a.capital_objetivo,
    a.capital_comprometido,
    round(
      case
        when a.capital_objetivo > 0 then a.capital_comprometido / a.capital_objetivo * 100
        else 0
      end,
      1
    ) as avance_pct,
    (
      select array_agg(distinct e.sector order by e.sector)
      from public.operaciones o
      join public.empresas_pagadoras e on e.id = o.empresa_id
      where o.pool_id = a.id
    ) as sectores
  from agregado a
  order by
    case when p_orden = 'avance_asc' then
      (case when a.capital_objetivo > 0 then a.capital_comprometido / a.capital_objetivo else 0 end)
    end asc nulls last,
    case when p_orden = 'monto_desc' then a.capital_objetivo end desc nulls last,
    case when p_orden = 'monto_asc' then a.capital_objetivo end asc nulls last,
    case when p_orden = 'vencimiento_asc' then a.fecha_vencimiento_esperada end asc nulls last,
    -- por defecto (incluye 'avance_desc' y cualquier valor no reconocido): avance descendente
    (case when a.capital_objetivo > 0 then a.capital_comprometido / a.capital_objetivo else 0 end) desc;
$$;

comment on function public.catalogo_pools (
  public.moneda_soportada,
  integer,
  public.perfil_riesgo_pool,
  public.sector_empresa,
  public.estado_pool,
  text
) is 'Listado agregado de pools con filtros combinables (FR-009..FR-012). contracts/catalogo-pools.md.';

revoke all on function public.catalogo_pools (
  public.moneda_soportada,
  integer,
  public.perfil_riesgo_pool,
  public.sector_empresa,
  public.estado_pool,
  text
)
from
  public,
  anon,
  authenticated;

grant
execute on function public.catalogo_pools (
  public.moneda_soportada,
  integer,
  public.perfil_riesgo_pool,
  public.sector_empresa,
  public.estado_pool,
  text
) to authenticated;

-- T015-T016 (Historia 2): detalle_pool() — toda la información agregada necesaria para decidir
-- entre tramo senior/junior, sin exponer nunca una operación o empresa individual (FR-014).
-- contracts/detalle-pool.md.
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
  from public.operaciones o
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

  return jsonb_build_object(
    'id', v_pool.id,
    'nombre', v_pool.nombre,
    'descripcion_corta', v_pool.descripcion_corta,
    'moneda', v_pool.moneda,
    'plazo_dias', v_pool.plazo_dias,
    'fecha_vencimiento_esperada', v_pool.fecha_vencimiento_esperada,
    'perfil_riesgo', v_pool.perfil_riesgo,
    'perfil_riesgo_explicacion', v_pool.perfil_riesgo_explicacion,
    'estado', v_pool.estado,
    'composicion', jsonb_build_object(
      'numero_operaciones', coalesce(v_num_operaciones, 0),
      'numero_empresas', coalesce(v_num_empresas, 0),
      'sectores', to_jsonb(coalesce(v_sectores, array[]::public.sector_empresa[])),
      'concentracion_maxima_pct', v_concentracion_maxima_pct
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
  'Detalle agregado de un pool para decidir entre tramos, sin exponer operaciones/empresas individuales (FR-013..FR-019). contracts/detalle-pool.md.';

revoke all on function public.detalle_pool (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.detalle_pool (uuid) to authenticated;
