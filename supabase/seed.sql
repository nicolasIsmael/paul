-- Feature: Registro, Inicio de Sesión y Perfil de Usuario (specs/20260919-131233-auth-perfil-usuario)
-- T021-T022: cuentas de demostración precargadas (Historia 4). Inserta directamente en
-- auth.users para que el trigger on_auth_user_created (0002_wallet_provisioning.sql) se dispare
-- igual que en un registro real -- incluido el aprovisionamiento real de wallet para los
-- inversionistas demo, vía el mismo Database Webhook. Nada de esto se hace desde el Dashboard
-- (Principio VII).
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
  -- durante T018 (validación de Historia 1) contra el proyecto real.
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
  );

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
  );

  -- T022: marcar como cuentas de demostración. El trigger on_auth_user_created ya creó la fila
  -- de perfiles correspondiente a cada insert de arriba; aquí solo se actualiza el flag
  -- es_cuenta_demo (ejecutado como postgres/dueño, no como `authenticated`, así que el REVOKE
  -- UPDATE de 0001_perfiles.sql no aplica a esta sentencia).
  update public.perfiles
  set
    es_cuenta_demo = true
  where
    id in (v_inv1, v_inv2, v_inv3, v_op1);
end $$;
