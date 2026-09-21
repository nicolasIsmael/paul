-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T040-T041 (Historia 3): soporte para que confirmar-aporte emita fracciones on-chain tras el
-- pago XLM, con compensación automática si el contrato falla de forma definitiva. Ver
-- contracts/confirmar-aporte-extension.md.

-- T040: hash de la invocación mint() del contrato — distinto de aportes.tx_hash (pago XLM
-- clásico vía Horizon). Nuevo valor de enum en sentencia separada (no se usa en esta misma
-- migración) para evitar el error de Postgres "unsafe use of new value of enum type".
alter table public.aportes
add column fraccion_tx_hash text;

alter type public.motivo_reversion_aporte
add value 'fallo_emision_fracciones';

-- T041: wrapper del secreto de custodia de un pool — mismo patrón exacto que
-- obtener_secreto_wallet(uuid), necesario para firmar el reembolso compensatorio (custodia del
-- pool -> wallet del inversionista) cuando el mint falla de forma definitiva.
create or replace function public.obtener_secreto_custodia_pool (p_pool_id uuid) returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where id = (select custody_secret_id from public.pools where id = p_pool_id);
$$;

revoke all on function public.obtener_secreto_custodia_pool (uuid)
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_secreto_custodia_pool (uuid) to service_role;
