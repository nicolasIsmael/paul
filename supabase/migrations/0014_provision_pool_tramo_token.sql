-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T036 (Historia 3): aprovisionamiento asíncrono de la instancia de contrato de cada tramo nuevo
-- — mismo patrón exacto que trigger_provision_pool_custody() (0005_custodia_pools.sql), ahora
-- disparado por `insert on tramos` en vez de `insert on pools`, porque cada tramo necesita su
-- propia instancia (research.md §1). Ver contracts/provision-pool-tramo-token-function.md.

create or replace function public.trigger_provision_pool_tramo_token () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shared_secret text;
  v_gateway_apikey text := public.obtener_gateway_apikey_functions ();
  v_function_url text := public.obtener_url_base_functions () || '/provision-pool-tramo-token';
  v_headers jsonb;
begin
  if new.token_contract_id is not null then
    return new;
  end if;

  select decrypted_secret
  into v_shared_secret
  from vault.decrypted_secrets
  where name = 'webhook_shared_secret';

  v_headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_shared_secret);
  if v_gateway_apikey is not null then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_gateway_apikey, 'apikey', v_gateway_apikey);
  end if;

  perform
    net.http_post (
      url := v_function_url,
      body := jsonb_build_object(
        'type', tg_op,
        'table', 'tramos',
        'schema', 'public',
        'record', to_jsonb (new),
        'old_record', null
      ),
      headers := v_headers,
      timeout_milliseconds := 20000
    );

  return new;
end;
$$;

comment on function public.trigger_provision_pool_tramo_token () is
  'contracts/provision-pool-tramo-token-function.md — instancia el contrato Soroban de un tramo nuevo. No se dispara para los tramos ya sembrados por la spec previa (solo INSERT).';

create trigger tramos_provision_token
after insert on public.tramos
for each row
execute function public.trigger_provision_pool_tramo_token ();

revoke all on function public.trigger_provision_pool_tramo_token ()
from
  public,
  anon,
  authenticated;
