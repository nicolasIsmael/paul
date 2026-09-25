-- Feature: Liquidación de Tramo (Cobro Simulado, Camino Feliz)
-- (specs/20260925-002004-liquidacion-tramo)
-- Fix encontrado al validar en vivo (T021): liquidar-tramo pagaba el monto nominal del tramo
-- (soles/dólares) directamente como si fueran XLM, sin convertir — tipo_cambio_vigente() existe
-- desde 0006_tipo_cambio.sql pero está revocada de toda invocación externa (solo la usan otras
-- funciones SECURITY DEFINER por SQL directo, nunca vía RPC de cliente). Se agrega un wrapper
-- mínimo, mismo patrón que obtener_secreto_custodia_pool/obtener_secreto_wallet — sin editar
-- 0006 ni 0018, ya aplicadas.
create or replace function public.obtener_tasa_cambio_liquidacion(p_moneda public.moneda_soportada)
returns numeric
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_tasa numeric;
begin
  select tasa_moneda_por_xlm into v_tasa from public.tipo_cambio_vigente(p_moneda);
  if v_tasa is null then
    raise exception 'No hay tipo de cambio vigente para %.', p_moneda using errcode = 'PA010';
  end if;
  return v_tasa;
end;
$$;

comment on function public.obtener_tasa_cambio_liquidacion(public.moneda_soportada) is
  'Wrapper de tipo_cambio_vigente() para liquidar-tramo — esa función es interna (revocada de
  public/anon/authenticated) y no se llama vía RPC directamente. Convención tasa_moneda_por_xlm =
  cuántas unidades de la moneda equivalen a 1 XLM (0006_tipo_cambio.sql).';

revoke all on function public.obtener_tasa_cambio_liquidacion(public.moneda_soportada)
  from public, anon, authenticated;
grant execute on function public.obtener_tasa_cambio_liquidacion(public.moneda_soportada)
  to service_role;
