-- SOLO LOCAL — NUNCA ejecutar este archivo contra el proyecto remoto (qqpozotcrxfukkwcoget).
-- Las 4 cuentas demo (3 inversionistas + 1 operador) ya existen ahí de verdad, creadas por la
-- feature previa (specs/20260919-131233-auth-perfil-usuario), con billeteras reales ya
-- aprovisionadas. Re-ejecutar este archivo en local (supabase db reset) recrea esas mismas
-- cuentas de forma idempotente (on conflict do nothing) para poder probar todo el flujo sin
-- depender del proyecto remoto.
--
-- Feature: Registro, Inicio de Sesión y Perfil de Usuario (specs/20260919-131233-auth-perfil-usuario)
-- Migrado desde el antiguo supabase/seed.sql como parte de
-- specs/20260920-113925-inversion-pools-aporte (T001) — mismo contenido, con
-- `on conflict (id) do nothing` añadido a ambos inserts para que sea seguro re-ejecutarlo incluso
-- si, por error, se corriera dos veces o contra un entorno que ya tiene estas filas.
--
-- Credenciales (no son secretas, ver spec.md > Assumptions; documentadas también en README.md):
--   inversionista.demo1@paul.test / DemoStellar2026!
--   inversionista.demo2@paul.test / DemoStellar2026!
--   inversionista.demo3@paul.test / DemoStellar2026!
--   operador.demo@paul.test        / DemoStellar2026!

create extension if not exists pgcrypto with schema extensions;

do $$
declare
  v_password text := 'DemoStellar2026!';
  v_instance_id uuid := '00000000-0000-0000-0000-000000000000';
  v_inv1 uuid := 'a0000000-0000-4000-8000-000000000001';
  v_inv2 uuid := 'a0000000-0000-4000-8000-000000000002';
  v_inv3 uuid := 'a0000000-0000-4000-8000-000000000003';
  v_op1 uuid := 'a0000000-0000-4000-8000-000000000004';
begin
  -- IMPORTANTE: `email_change` debe ser '' y no NULL (default de la columna) — si queda NULL,
  -- GoTrue falla con "converting NULL to string is unsupported" al buscar duplicados en
  -- CUALQUIER intento de registro posterior, no solo con estas cuentas. Detectado y corregido
  -- durante T018 de la feature previa (validación de Historia 1) contra el proyecto real.
  insert into
    auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change,
      email_change_token_current,
      phone_change_token,
      reauthentication_token,
      created_at,
      updated_at
    )
  values (
    v_instance_id, v_inv1, 'authenticated', 'authenticated', 'inversionista.demo1@paul.test',
    extensions.crypt (v_password, extensions.gen_salt ('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('rol', 'inversionista', 'nombre_completo', 'Inversionista Demo Uno', 'telefono', '999000001'),
    '', '', '', '', '', '', '', now(), now()
  ), (
    v_instance_id, v_inv2, 'authenticated', 'authenticated', 'inversionista.demo2@paul.test',
    extensions.crypt (v_password, extensions.gen_salt ('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('rol', 'inversionista', 'nombre_completo', 'Inversionista Demo Dos', 'telefono', '999000002'),
    '', '', '', '', '', '', '', now(), now()
  ), (
    v_instance_id, v_inv3, 'authenticated', 'authenticated', 'inversionista.demo3@paul.test',
    extensions.crypt (v_password, extensions.gen_salt ('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('rol', 'inversionista', 'nombre_completo', 'Inversionista Demo Tres', 'telefono', '999000003'),
    '', '', '', '', '', '', '', now(), now()
  ), (
    v_instance_id, v_op1, 'authenticated', 'authenticated', 'operador.demo@paul.test',
    extensions.crypt (v_password, extensions.gen_salt ('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('rol', 'operador_banco', 'nombre_completo', 'Operador Demo Banco'),
    '', '', '', '', '', '', '', now(), now()
  )
  on conflict (id) do nothing;

  insert into
    auth.identities (
      id,
      provider_id,
      user_id,
      identity_data,
      provider,
      last_sign_in_at,
      created_at,
      updated_at
    )
  values (
    gen_random_uuid (), v_inv1::text, v_inv1,
    jsonb_build_object('sub', v_inv1::text, 'email', 'inversionista.demo1@paul.test'),
    'email', now(), now(), now()
  ), (
    gen_random_uuid (), v_inv2::text, v_inv2,
    jsonb_build_object('sub', v_inv2::text, 'email', 'inversionista.demo2@paul.test'),
    'email', now(), now(), now()
  ), (
    gen_random_uuid (), v_inv3::text, v_inv3,
    jsonb_build_object('sub', v_inv3::text, 'email', 'inversionista.demo3@paul.test'),
    'email', now(), now(), now()
  ), (
    gen_random_uuid (), v_op1::text, v_op1,
    jsonb_build_object('sub', v_op1::text, 'email', 'operador.demo@paul.test'),
    'email', now(), now(), now()
  )
  on conflict (provider, provider_id) do nothing;

  -- El trigger on_auth_user_created ya creó la fila de perfiles correspondiente a cada insert de
  -- arriba; aquí solo se actualiza el flag es_cuenta_demo (ejecutado como postgres/dueño, no como
  -- `authenticated`, así que el REVOKE UPDATE de 0001_perfiles.sql no aplica a esta sentencia).
  update public.perfiles
  set
    es_cuenta_demo = true
  where
    id in (v_inv1, v_inv2, v_inv3, v_op1);
end $$;
