-- Alineacion operativa de la liquidacion de tramos con el frontend del operador.
-- PA024: existe otra ejecucion de liquidacion vigente para el tramo.

alter table public.tramos
  add column liquidacion_intento_id uuid,
  add column liquidacion_bloqueo_hasta timestamptz;

comment on column public.tramos.liquidacion_intento_id is
  'Clave idempotente de la ejecucion activa de liquidacion.';

comment on column public.tramos.liquidacion_bloqueo_hasta is
  'Lease corta que evita dos liquidaciones on-chain concurrentes del mismo tramo.';

drop function public.iniciar_liquidacion_tramo(uuid);

create function public.iniciar_liquidacion_tramo(
  p_tramo_id uuid,
  p_intento_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_tramo public.tramos;
  v_facturas_pendientes uuid[];
begin
  if p_intento_id is null then
    raise exception 'La clave idempotente es obligatoria.' using errcode = 'PA012';
  end if;

  select * into v_tramo from public.tramos where id = p_tramo_id for update;
  if not found then
    raise exception 'Tramo no encontrado.' using errcode = 'PA023';
  end if;

  if v_tramo.estado_liquidacion = 'liquidado' then
    raise exception 'El tramo ya fue liquidado.' using errcode = 'PA021';
  end if;

  if v_tramo.estado_liquidacion = 'liquidando'
    and v_tramo.liquidacion_intento_id is distinct from p_intento_id
    and coalesce(v_tramo.liquidacion_bloqueo_hasta, '-infinity'::timestamptz) > now()
  then
    raise exception 'El tramo ya tiene una liquidacion en curso.' using errcode = 'PA024';
  end if;

  -- La validacion se repite tambien al reanudar. Una factura no puede volver a un estado
  -- pendiente sin impedir el siguiente intento.
  select array_agg(id) into v_facturas_pendientes
  from public.facturas
  where tramo_id = p_tramo_id and estado_cobro <> 'cobrada';

  if v_facturas_pendientes is not null and array_length(v_facturas_pendientes, 1) > 0 then
    raise exception 'El tramo tiene facturas sin cobrar: %.', v_facturas_pendientes
    using errcode = 'PA022';
  end if;

  update public.tramos
  set
    estado_liquidacion = 'liquidando',
    liquidacion_intento_id = p_intento_id,
    liquidacion_bloqueo_hasta = now() + interval '10 minutes'
  where id = p_tramo_id;

  return jsonb_build_object(
    'tramo_id', p_tramo_id,
    'reanudada', v_tramo.estado_liquidacion = 'liquidando',
    'inversionistas', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'investor_id', a.investor_id,
        'wallet_public_key', p.wallet_public_key
      )), '[]'::jsonb)
      from (
        select distinct ap.investor_id
        from public.aportes ap
        where ap.tramo_id = p_tramo_id and ap.estado = 'confirmado'
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

comment on function public.iniciar_liquidacion_tramo(uuid, uuid) is
  'Inicia o reanuda de forma idempotente una liquidacion; impide ejecuciones concurrentes.';

revoke all on function public.iniciar_liquidacion_tramo(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.iniciar_liquidacion_tramo(uuid, uuid) to service_role;

drop function public.finalizar_liquidacion_tramo(uuid);

create function public.finalizar_liquidacion_tramo(
  p_tramo_id uuid,
  p_intento_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.tramos
  set
    estado_liquidacion = 'liquidado',
    liquidacion_bloqueo_hasta = null
  where id = p_tramo_id
    and estado_liquidacion = 'liquidando'
    and liquidacion_intento_id = p_intento_id;

  if not found then
    raise exception 'La ejecucion de liquidacion ya no es la vigente.' using errcode = 'PA024';
  end if;
end;
$$;

revoke all on function public.finalizar_liquidacion_tramo(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.finalizar_liquidacion_tramo(uuid, uuid) to service_role;

-- Lectura consolidada para la bandeja operativa. Los nombres identificables de las facturas se
-- siguen obteniendo exclusivamente desde listar_facturas_operador().
create function public.listar_tramos_liquidacion_operador() returns table (
  tramo_id uuid,
  pool_id uuid,
  pool_nombre text,
  moneda public.moneda_soportada,
  pool_estado public.estado_pool,
  tramo_tipo public.tipo_tramo,
  rendimiento_pct numeric,
  capital_comprometido numeric,
  estado_liquidacion text,
  token_contract_id text,
  facturas_total bigint,
  facturas_cobradas bigint,
  facturas_pendientes bigint,
  facturas_en_mora bigint,
  inversionistas_total bigint,
  resultados_pagados bigint,
  resultados_compensados bigint
)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
begin
  if (select rol from public.perfiles where id = (select auth.uid())) is distinct from 'operador_banco' then
    raise exception 'Solo el operador de banco puede consultar liquidaciones.' using errcode = 'PA008';
  end if;

  return query
  select
    t.id,
    p.id,
    p.nombre,
    p.moneda,
    p.estado,
    t.tipo,
    t.rendimiento_ilustrativo_plazo_pct,
    t.capital_comprometido,
    t.estado_liquidacion,
    t.token_contract_id,
    count(distinct f.id),
    count(distinct f.id) filter (where f.estado_cobro = 'cobrada'),
    count(distinct f.id) filter (where f.estado_cobro = 'pendiente'),
    count(distinct f.id) filter (where f.estado_cobro = 'en_mora'),
    count(distinct a.investor_id) filter (where a.estado = 'confirmado'),
    count(distinct l.investor_id) filter (where l.estado = 'pagado'),
    count(distinct l.investor_id) filter (where l.estado = 'compensado')
  from public.tramos t
  join public.pools p on p.id = t.pool_id
  left join public.facturas f on f.tramo_id = t.id and f.estado_asignacion = 'asignada'
  left join public.aportes a on a.tramo_id = t.id
  left join public.liquidaciones_tramo_inversionista l on l.tramo_id = t.id
  group by t.id, p.id
  order by
    case t.estado_liquidacion when 'liquidando' then 0 when 'activo' then 1 else 2 end,
    p.nombre,
    t.tipo;
end;
$$;

comment on function public.listar_tramos_liquidacion_operador() is
  'Bandeja consolidada para cobro y liquidacion de tramos del operador.';

revoke all on function public.listar_tramos_liquidacion_operador()
from public, anon, authenticated;
grant execute on function public.listar_tramos_liquidacion_operador() to authenticated;
