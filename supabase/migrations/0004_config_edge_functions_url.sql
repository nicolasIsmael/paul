-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T025: corrige research.md §2 — trigger_provision_wallet() tenía la URL de producción
-- hardcodeada, lo que rompía el aprovisionamiento de wallet al probar en local (la llamada
-- terminaba apuntando siempre a producción, nunca al runtime local). Se corrige sin editar la
-- migración 0002 ya aplicada (CREATE OR REPLACE sobre el objeto existente).
--
-- Hallazgos adicionales durante la validación local de esta migración (quickstart.md):
-- 1) el secreto `webhook_shared_secret` que usa la autenticación del webhook tampoco existía en
--    el entorno local — se había creado manualmente solo contra el proyecto remoto durante la
--    feature previa, nunca versionado. Se corrige aquí también: se genera automáticamente si
--    falta (idempotente, no toca el valor ya existente en remoto).
-- 2) el API Gateway (Kong) del stack LOCAL exige un header `Authorization`/`apikey` válido para
--    enrutar cualquier request hacia `/functions/v1/*`, incluso hacia una función desplegada con
--    `verify_jwt=false` (ese flag solo controla si la propia Edge Function exige JWT, no si Kong
--    deja pasar la solicitud). En producción esto NO hace falta — verificado en la feature previa
--    (T018: el webhook de wallet funcionó sin este header) — así que se agrega como un header
--    condicional: si existe el secreto `edge_functions_gateway_apikey` en Vault (solo se crea
--    aquí con un valor por defecto para local), se envía; si no existe (remoto, donde nunca se
--    crea automáticamente), no se envía nada, igual que hoy.

do $$
declare
  v_existing_id uuid;
begin
  -- Genera el secreto compartido del webhook si todavía no existe en este entorno (siempre falso
  -- en remoto, donde ya se creó manualmente durante la feature previa; siempre cierto la primera
  -- vez en un entorno local nuevo).
  select id into v_existing_id from vault.secrets where name = 'webhook_shared_secret';

  if v_existing_id is null then
    perform vault.create_secret (
      encode (gen_random_bytes (32), 'hex'),
      'webhook_shared_secret',
      'Secreto compartido entre los triggers de aprovisionamiento (wallet de inversionista, custodia de pool) y sus Edge Functions correspondientes.'
    );
  end if;

  -- URL base de las Edge Functions de este entorno. Valor por defecto = desarrollo local
  -- (Docker Desktop: host.docker.internal resuelve al host desde el contenedor de Postgres).
  -- IMPORTANTE: al aplicar esta migración contra el proyecto remoto (`supabase db push`), este
  -- valor por defecto queda apuntando a local — hay que actualizarlo manualmente una sola vez a
  -- la URL real de producción antes de que cualquier registro dispare el webhook en remoto:
  --   select vault.update_secret(id, 'https://qqpozotcrxfukkwcoget.supabase.co/functions/v1')
  --   from vault.secrets where name = 'edge_functions_base_url';
  -- Ver quickstart.md §7.
  select id into v_existing_id from vault.secrets where name = 'edge_functions_base_url';

  if v_existing_id is null then
    perform vault.create_secret (
      'http://host.docker.internal:54321/functions/v1',
      'edge_functions_base_url',
      'URL base de las Edge Functions de este entorno. Por defecto apunta a desarrollo local — actualizar manualmente para el proyecto remoto (ver comentario en esta migración y quickstart.md §7).'
    );
  end if;

  -- apikey/Authorization que el Kong LOCAL exige para enrutar a /functions/v1/* (hallazgo 2
  -- arriba). Es el "anon key" fijo y público de cualquier stack local de Supabase (no es un
  -- secreto real — mismo valor documentado por `supabase status` en cualquier proyecto local).
  -- NUNCA se crea aquí un valor por defecto para remoto: si este secreto no existe, las funciones
  -- de trigger simplemente no agregan el header, igual que el comportamiento ya verificado en
  -- producción. La detección de entorno es real, no solo un comentario: todo stack local de
  -- Supabase deja fijo `app.settings.jwt_secret` en el valor por defecto del template
  -- (`super-secret-jwt-token-with-at-least-32-characters-long`); en el proyecto remoto ese GUC
  -- no está seteado (NULL) — verificado en vivo contra ambos entornos antes de aplicar esta
  -- migración a producción.
  if current_setting('app.settings.jwt_secret', true) = 'super-secret-jwt-token-with-at-least-32-characters-long' then
    select id into v_existing_id from vault.secrets where name = 'edge_functions_gateway_apikey';

    if v_existing_id is null then
      perform vault.create_secret (
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
        'edge_functions_gateway_apikey',
        'apikey/Authorization que exige el Kong LOCAL para enrutar a /functions/v1/*; el anon key público fijo del stack local de Supabase, no un secreto real. No se crea automáticamente en remoto — ver comentario al inicio de esta migración.'
      );
    end if;
  end if;
end $$;

-- Wrapper análogo a obtener_shared_secret_webhook() (0002_wallet_provisioning.sql): `vault` no es
-- un esquema expuesto por PostgREST ni alcanzable desde SQL fuera de una función que lo consulte
-- directamente; este wrapper resuelve eso sin exponer el esquema vault completo.
create or replace function public.obtener_url_base_functions () returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_base_url';
$$;

revoke all on function public.obtener_url_base_functions ()
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_url_base_functions () to service_role;

-- Devuelve NULL en cualquier entorno donde 'edge_functions_gateway_apikey' no se haya creado
-- (remoto) — los triggers que lo usan omiten el header por completo en ese caso.
create or replace function public.obtener_gateway_apikey_functions () returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_gateway_apikey';
$$;

revoke all on function public.obtener_gateway_apikey_functions ()
from
  public,
  anon,
  authenticated;

grant
execute on function public.obtener_gateway_apikey_functions () to service_role;

-- CREATE OR REPLACE sobre la función ya creada en 0002_wallet_provisioning.sql — mismo cuerpo,
-- solo cambia v_function_url para dejar de hardcodear el entorno.
create or replace function public.trigger_provision_wallet () returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shared_secret text;
  v_gateway_apikey text := public.obtener_gateway_apikey_functions ();
  v_function_url text := public.obtener_url_base_functions () || '/provision-investor-wallet';
  v_headers jsonb;
begin
  if new.rol is distinct from 'inversionista' or new.wallet_secret_id is not null then
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
        'table', 'perfiles',
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

revoke all on function public.trigger_provision_wallet ()
from
  public,
  anon,
  authenticated;
