-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T007-T015: esquema de originación de facturas. Renombra `operaciones` a `facturas` (research.md
-- §7) y corrige de inmediato catalogo_pools()/detalle_pool() (0009_catalogo_consultas.sql) para
-- que sigan funcionando sobre la tabla renombrada — sin este último paso, ambas quedarían rotas
-- entre esta migración y la de Historia 4. Ver data-model.md para el detalle de cada columna.

-- T007: proveedores (nueva). Nunca se expone su nombre_comercial a un inversionista.
create table public.proveedores (
  id uuid primary key default gen_random_uuid (),
  nombre_comercial text not null,
  created_at timestamptz not null default now()
);

comment on table public.proveedores is
  'Empresa ficticia titular de una factura por cobrar; solo el operador de banco ve su nombre (FR-020/FR-021).';

alter table public.proveedores enable row level security;

revoke all on public.proveedores
from
  anon,
  authenticated;

-- T008: enums del ciclo de vida de una factura.
create type public.estado_validacion_factura as enum ('aprobada', 'rechazada');

create type public.estado_cobro_factura as enum ('pendiente', 'cobrada', 'en_mora');

create type public.estado_asignacion_factura as enum (
  'sin_asignar',
  'pendiente_onchain',
  'asignada',
  'rechazada_asignacion'
);

-- T009: rename + columnas nuevas de originación. Los `default` de las columnas nuevas NOT NULL
-- cubren únicamente las filas ya sembradas por la spec previa (que nacieron directamente
-- "asignadas" sin pasar por este flujo).
alter table public.operaciones
rename to facturas;

alter table public.facturas
alter column pool_id
drop not null,
add column proveedor_id uuid references public.proveedores (id),
add column fecha_emision date not null default current_date,
add column fecha_vencimiento date not null default (current_date + interval '30 days'),
add column huella_hash text not null default '',
add column estado_validacion public.estado_validacion_factura not null default 'aprobada',
add column motivo_rechazo text,
add column estado_cobro public.estado_cobro_factura not null default 'pendiente',
add column estado_asignacion public.estado_asignacion_factura not null default 'sin_asignar',
add column tramo_id uuid references public.tramos (id),
add column anticipo numeric(14, 2),
add column onchain_tx_hash text;

-- Las 22 filas ya sembradas no tienen un proveedor real (la spec previa nunca modeló ese
-- concepto) — se les asigna un proveedor placeholder explícito en vez de dejar la columna
-- nulificable de forma permanente; supabase/seed/03_originacion_facturas_demo.sql puede
-- reemplazarlo por proveedores de ejemplo reales si se desea mayor fidelidad narrativa, pero el
-- esquema queda coherente (NOT NULL) desde esta misma migración.
insert into
  public.proveedores (id, nombre_comercial)
values
  (
    '00000000-0000-4000-8000-000000000000',
    'Proveedor no especificado (dato heredado de la feature previa)'
  )
on conflict (id) do nothing;

update public.facturas
set proveedor_id = '00000000-0000-4000-8000-000000000000'
where proveedor_id is null;

alter table public.facturas
alter column proveedor_id
set not null;

-- Las filas ya sembradas nacieron "asignadas" en la spec previa, pero a nivel de POOL, nunca de
-- tramo (la spec previa no distinguía tramo por operación) — se les asigna aquí el tramo senior
-- de su propio pool como backfill razonable: no altera ningún agregado ya mostrado al
-- inversionista (composicion/detalle_pool sigue agregando por pool_id, nunca por tramo_id) y dejan
-- el esquema coherente con la constraint de T010 sin esperar al seed de esta feature.
update public.facturas f
set
  estado_asignacion = 'asignada',
  anticipo = f.monto_nominal,
  tramo_id = (select t.id from public.tramos t where t.pool_id = f.pool_id and t.tipo = 'senior')
where
  f.pool_id is not null;

comment on table public.facturas is
  'Factura fraccionable (antes "operaciones") — ciclo de vida completo de originación: registro, validación, asignación a un pool/tramo con anticipo. Nunca expuesta individualmente a un inversionista salvo vía facturas_del_pool() (anonimizada). Ver data-model.md.';

-- T010: constraints de coherencia.
alter table public.facturas
add constraint facturas_anticipo_valido check (
  anticipo is null
  or (
    anticipo > 0
    and anticipo <= monto_nominal
  )
),
add constraint facturas_asignacion_coherente check (
  (
    estado_asignacion = 'sin_asignar'
    and tramo_id is null
    and pool_id is null
    and anticipo is null
  )
  or (
    estado_asignacion <> 'sin_asignar'
    and tramo_id is not null
    and pool_id is not null
    and anticipo is not null
  )
);

-- T011: el trigger de coherencia de moneda (0003_dominio_pools.sql) exigía siempre un pool; ahora
-- una factura puede nacer sin pool, así que solo se valida cuando ya tiene uno asignado.
drop trigger operaciones_moneda_coincide_pool on public.facturas;

create or replace function public.facturas_moneda_coincide_pool () returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pool_id is not null
    and new.moneda is distinct from (select moneda from public.pools where id = new.pool_id) then
    raise exception 'La moneda de la factura debe coincidir con la moneda de su pool (FR-039).';
  end if;
  return new;
end;
$$;

create trigger facturas_moneda_coincide_pool
before insert or update on public.facturas
for each row
execute function public.facturas_moneda_coincide_pool ();

-- T012: columnas nuevas de tramos — monto financiado acumulado por anticipos, reserva (residuo
-- que no completa una fracción adicional), fracciones totales, e instancia del contrato Soroban
-- de este tramo.
alter table public.tramos
add column monto_financiado_acumulado numeric(14, 2) not null default 0 check (monto_financiado_acumulado >= 0),
add column reserva numeric(14, 2) not null default 0 check (reserva >= 0),
add column fracciones_totales integer not null default 0 check (fracciones_totales >= 0),
add column token_contract_id text;

-- Los tramos ya sembrados por la spec previa nacieron con capital_objetivo fijo, exactamente
-- respaldado 1:1 por sus operaciones (verificado contra el seed: monto_nominal suma exactamente
-- capital_objetivo por tramo) — se retrocompletan aquí para mantener el invariante de
-- data-model.md (capital_objetivo = fracciones_totales * unidad_minima_aporte) sin esperar al
-- seed de esta feature.
update public.tramos t
set
  monto_financiado_acumulado = t.capital_objetivo,
  fracciones_totales = round(t.capital_objetivo / p.unidad_minima_aporte)::integer
from
  public.pools p
where
  t.pool_id = p.id;

-- T013: defensa en profundidad — capital_objetivo siempre múltiplo exacto de la unidad mínima del
-- pool (research.md §6). PA014 reutilizado (mismo código que "datos de factura incoherentes": en
-- ambos casos el error de negocio es "un monto no respeta la granularidad exigida").
create or replace function public.tramos_capital_objetivo_multiplo () returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unidad_minima numeric;
begin
  select unidad_minima_aporte into v_unidad_minima from public.pools where id = new.pool_id;

  if mod(new.capital_objetivo, v_unidad_minima) <> 0 then
    raise exception 'capital_objetivo debe ser múltiplo de la unidad mínima del pool.' using errcode = 'PA014';
  end if;

  return new;
end;
$$;

create trigger tramos_capital_objetivo_multiplo
before insert or update of capital_objetivo on public.tramos
for each row
execute function public.tramos_capital_objetivo_multiplo ();

-- T014: margen de plazo propio de cada pool respecto al vencimiento de sus facturas (FR-023).
alter table public.pools
add column margen_plazo_dias integer not null default 5 check (margen_plazo_dias >= 0);

-- T015: corregir de inmediato las dos funciones ya desplegadas que referencian
-- `public.operaciones` (0009_catalogo_consultas.sql) — mismo comportamiento observable, sin
-- ningún campo nuevo todavía (los campos nuevos de Historia 4/5 llegan en
-- 0013_facturas_del_pool_y_detalle.sql). Patrón ya usado por 0004_config_edge_functions_url.sql
-- sobre una migración previa ya aplicada: CREATE OR REPLACE, nunca editar el archivo original.
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
          from public.facturas o
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
      from public.facturas o
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
    (case when a.capital_objetivo > 0 then a.capital_comprometido / a.capital_objetivo else 0 end) desc;
$$;

comment on function public.catalogo_pools (
  public.moneda_soportada,
  integer,
  public.perfil_riesgo_pool,
  public.sector_empresa,
  public.estado_pool,
  text
) is 'Listado agregado de pools con filtros combinables (FR-009..FR-012). contracts/catalogo-pools.md. Corregida en 0011 para leer de `facturas` tras el rename de `operaciones`.';

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
  'Detalle agregado de un pool (FR-013..FR-019). contracts/detalle-pool.md. Corregida en 0011 para leer de `facturas` tras el rename de `operaciones`; 0013 le agrega margen_plazo_dias/estado_facturas.';

revoke all on function public.detalle_pool (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.detalle_pool (uuid) to authenticated;
