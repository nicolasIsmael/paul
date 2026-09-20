-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T026: aprovisionamiento de la cuenta de custodia dedicada de cada pool — mismo patrón que
-- aprovisionar_wallet_inversionista (0002_wallet_provisioning.sql), reutilizando desde el
-- principio el mecanismo de URL configurable de 0004_config_edge_functions_url.sql (research.md
-- §2 y §4: una cuenta de custodia por pool, nunca una única cuenta compartida con memo).

create or replace function public.aprovisionar_custodia_pool (
  pool_id uuid,
  custody_public_key text,
  custody_secret text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  -- Idempotente: si el pool ya tiene custodia, no hace nada (evita duplicate key en vault.secrets
  -- ante un reintento del webhook — mismo hallazgo que aprovisionar_wallet_inversionista).
  if exists (
    select 1 from public.pools
    where id = pool_id and custody_secret_id is not null
  ) then
    return;
  end if;

  select
    vault.create_secret (
      custody_secret,
      'stellar_pool_custody_' || pool_id::text
    ) into v_secret_id;

  update public.pools
  set
    custody_public_key = aprovisionar_custodia_pool.custody_public_key,
    custody_secret_id = v_secret_id
  where
    id = pool_id
    and custody_secret_id is null;
end;
$$;

revoke all on function public.aprovisionar_custodia_pool (uuid, text, text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.aprovisionar_custodia_pool (uuid, text, text) to service_role;

-- Dispara el aprovisionamiento de custodia de forma asíncrona (vía pg_net) cuando se crea un pool
-- nuevo — contracts/provision-pool-custody-function.md.
create or replace function public.trigger_provision_pool_custody () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shared_secret text;
  v_gateway_apikey text := public.obtener_gateway_apikey_functions ();
  v_function_url text := public.obtener_url_base_functions () || '/provision-pool-custody';
  v_headers jsonb;
begin
  if new.custody_secret_id is not null then
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
        'table', 'pools',
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

create trigger pools_provision_custody
after insert on public.pools
for each row
execute function public.trigger_provision_pool_custody ();

revoke all on function public.trigger_provision_pool_custody ()
from
  public,
  anon,
  authenticated;
