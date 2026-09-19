-- Feature: Registro, Inicio de Sesión y Perfil de Usuario (specs/20260919-131233-auth-perfil-usuario)
-- T009-T012 y T016: creación de perfil al registrarse, inmutabilidad de rol, y aprovisionamiento
-- de wallet disparado por un trigger — todo SQL versionado, nunca creado desde el Dashboard
-- (Principio VII). Ver research.md §3-§5.
--
-- Sin login social (decisión explícita del equipo): el rol siempre viaja en el propio signUp()
-- que crea la cuenta, así que no existe ningún estado transitorio "cuenta sin rol" ni una función
-- de "completar registro" — a diferencia de una primera versión de este diseño que sí las tenía
-- para soportar Google OAuth.

-- Necesario para net.http_post() en trigger_provision_wallet (más abajo).
create extension if not exists pg_net;

-- T009: crear la fila de perfiles al registrarse. email/contraseña es el único método soportado,
-- así que rol/nombre_completo/telefono siempre vienen en raw_user_meta_data.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.perfiles (id, rol, nombre_completo, telefono)
  values (
    new.id,
    (new.raw_user_meta_data ->> 'rol')::public.perfil_rol,
    new.raw_user_meta_data ->> 'nombre_completo',
    new.raw_user_meta_data ->> 'telefono'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

-- IMPORTANTE (hallazgo de los Security Advisors en T027, ver research.md §5): Postgres/Supabase
-- concede EXECUTE por defecto a PUBLIC en toda función nueva, y en este proyecto además concede
-- privilegios explícitos a `anon`/`authenticated` — no basta con revocar de PUBLIC. Esta función
-- solo existe como trigger; nunca debe ser invocable vía /rest/v1/rpc/handle_new_user.
revoke all on function public.handle_new_user ()
from public, anon, authenticated;

-- T010: el rol es inmutable una vez fijado (FR-003). Como `perfiles.rol` es NOT NULL desde la
-- creación (no hay login social que deje un estado transitorio sin rol), cualquier cambio se
-- rechaza directamente, sin necesitar distinguir "primera fijación" de "cambio posterior".
create or replace function public.perfiles_rol_inmutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.rol is distinct from old.rol then
    raise exception 'El rol de la cuenta es inmutable una vez fijado (FR-003).';
  end if;
  return new;
end;
$$;

create trigger perfiles_rol_inmutable
before update on public.perfiles
for each row
execute function public.perfiles_rol_inmutable();

-- T012: aprovisionamiento atómico de la wallet — solo invocable por service_role (la Edge
-- Function). Guarda la llave privada en Supabase Vault; perfiles solo guarda la referencia.
-- Idempotente: si ya existe wallet para este perfil (p. ej. por un reintento del webhook tras
-- un timeout de pg_net cuyo request original igual llegó a completarse), no hace nada — evita
-- el "duplicate key value violates unique constraint secrets_name_idx" observado en T018.
create or replace function public.aprovisionar_wallet_inversionista(
  perfil_id uuid,
  wallet_public_key text,
  wallet_secret text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if exists (
    select 1 from public.perfiles
    where id = perfil_id and wallet_secret_id is not null
  ) then
    return;
  end if;

  select
    vault.create_secret (
      wallet_secret,
      'stellar_wallet_' || perfil_id::text
    ) into v_secret_id;

  update public.perfiles
  set
    wallet_public_key = aprovisionar_wallet_inversionista.wallet_public_key,
    wallet_secret_id = v_secret_id
  where
    id = perfil_id
    and rol = 'inversionista'
    and wallet_secret_id is null;
end;
$$;

-- CRÍTICO: sin el revoke explícito de anon/authenticated (no solo de PUBLIC), cualquier usuario
-- autenticado podía llamar a esta función con un perfil_id ajeno e inyectar una wallet falsa en
-- la cuenta de otro inversionista mientras su wallet_secret_id siguiera NULL. Hallado y corregido
-- en T027 (Security Advisors) contra el proyecto real.
revoke all on function public.aprovisionar_wallet_inversionista (uuid, text, text)
from public, anon, authenticated;

grant
execute on function public.aprovisionar_wallet_inversionista (uuid, text, text) to service_role;

-- T016: dispara el aprovisionamiento de wallet de forma asíncrona (vía pg_net) cuando un
-- perfil nuevo queda en rol='inversionista'. Solo reacciona a INSERT: sin login social, el rol
-- nunca se fija después vía UPDATE (a diferencia de una primera versión de este diseño, que sí
-- necesitaba reaccionar también a UPDATE para el caso Google).
--
-- Autenticación del webhook: la Edge Function se despliega con verify_jwt=false (justificado:
-- implementa su propia autenticación custom, ver Edge Function) porque este trigger no tiene
-- forma de obtener la service_role key real (no se expone ni siquiera a este agente vía MCP).
-- En su lugar, un secreto compartido generado por la propia base de datos
-- ('webhook_shared_secret', creado una sola vez con vault.create_secret(encode(gen_random_bytes(32),'hex'), ...))
-- se lee de Vault en cada invocación y se envía como header x-webhook-secret; la Edge Function
-- vuelve a leer el mismo secreto de Vault (con su SUPABASE_SERVICE_ROLE_KEY autoinyectado) para
-- compararlo. El secreto en sí nunca queda en texto plano en este archivo versionado.
create or replace function public.trigger_provision_wallet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shared_secret text;
  v_function_url text := 'https://qqpozotcrxfukkwcoget.supabase.co/functions/v1/provision-investor-wallet';
begin
  if new.rol is distinct from 'inversionista' or new.wallet_secret_id is not null then
    return new;
  end if;

  select decrypted_secret
  into v_shared_secret
  from vault.decrypted_secrets
  where name = 'webhook_shared_secret';

  -- Forma del payload: la misma que documenta contracts/provision-investor-wallet-function.md
  -- (equivalente a lo que enviaría supabase_functions.http_request), para que la Edge Function
  -- se parseé exactamente contra ese contrato ya publicado.
  -- timeout_milliseconds ampliado: generar el keypair + fondear vía Friendbot + escribir en
  -- Vault supera holgadamente el default de pg_net (5000ms), sobre todo en cold start.
  perform
    net.http_post (
      url := v_function_url,
      body := jsonb_build_object(
        'type', tg_op,
        'table', 'perfiles',
        'schema', 'public',
        'record', to_jsonb(new),
        'old_record', null
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-webhook-secret', v_shared_secret
      ),
      timeout_milliseconds := 20000
    );

  return new;
end;
$$;

create trigger perfiles_provision_wallet
after insert on public.perfiles
for each row
execute function public.trigger_provision_wallet();

-- Solo existe como trigger; nunca invocable vía /rest/v1/rpc/trigger_provision_wallet
-- (ver nota sobre PUBLIC/anon/authenticated en handle_new_user, arriba).
revoke all on function public.trigger_provision_wallet ()
from public, anon, authenticated;

-- La Edge Function no puede leer `vault.decrypted_secrets` directamente vía supabase-js/PostgREST
-- porque el esquema `vault` no está en los esquemas expuestos de la API (solo `public` lo está).
-- Este wrapper en `public` resuelve eso sin exponer el esquema `vault` completo — mismo patrón
-- que aprovisionar_wallet_inversionista.
create or replace function public.obtener_shared_secret_webhook()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'webhook_shared_secret';
$$;

-- CRÍTICO: sin el revoke explícito de anon/authenticated, cualquiera podía leer el secreto
-- compartido del webhook vía /rest/v1/rpc/obtener_shared_secret_webhook y falsificar llamadas
-- directas a la Edge Function saltándose el trigger. Hallado y corregido en T027.
revoke all on function public.obtener_shared_secret_webhook ()
from public, anon, authenticated;

grant
execute on function public.obtener_shared_secret_webhook () to service_role;
