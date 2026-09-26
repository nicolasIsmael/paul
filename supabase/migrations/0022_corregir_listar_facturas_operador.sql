-- Evita la colision entre la columna de salida `id` y perfiles.id en PL/pgSQL.
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
  if (
    select pf.rol
    from public.perfiles pf
    where pf.id = (select auth.uid())
  ) is distinct from 'operador_banco' then
    raise exception 'Solo el operador de banco puede listar facturas con datos identificables.'
    using errcode = 'PA008';
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
) is 'Listado identificable para el operador; guard de rol sin ambiguedad PL/pgSQL.';

revoke all on function public.listar_facturas_operador (
  public.estado_validacion_factura, public.estado_asignacion_factura
) from public, anon, authenticated;

grant execute on function public.listar_facturas_operador (
  public.estado_validacion_factura, public.estado_asignacion_factura
) to authenticated;
