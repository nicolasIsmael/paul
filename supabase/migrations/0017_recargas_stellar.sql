-- Recargas sincronizadas con Stellar Testnet.
-- La recarga se reserva primero, se paga desde una tesoreria de demo custodiada en Vault y solo
-- entonces incrementa el saldo contable. Las funciones internas son exclusivas de service_role.

create type public.estado_recarga_stellar as enum ('reservada', 'confirmada', 'revertida');

alter table public.recargas_saldo
  add column idempotency_key uuid,
  add column monto_xlm numeric(20, 7) check (monto_xlm is null or monto_xlm > 0),
  add column tx_hash text,
  add column tx_xdr text,
  add column estado public.estado_recarga_stellar not null default 'confirmada',
  add column confirmada_at timestamptz default now(),
  add column motivo_fallo text;

create unique index recargas_saldo_idempotency_unique
  on public.recargas_saldo (investor_id, idempotency_key)
  where idempotency_key is not null;

create unique index recargas_saldo_tx_hash_unique
  on public.recargas_saldo (tx_hash)
  where tx_hash is not null;

create table public.tesoreria_stellar_demo (
  singleton boolean primary key default true check (singleton),
  public_key text not null unique,
  secret_id uuid not null unique,
  created_at timestamptz not null default now()
);

comment on table public.tesoreria_stellar_demo is
  'Cuenta Testnet que fondea recargas demo. El secreto vive cifrado en Supabase Vault.';

alter table public.tesoreria_stellar_demo enable row level security;

revoke all on public.tesoreria_stellar_demo from public, anon, authenticated;

-- La antigua RPC acreditaba saldo sin movimiento on-chain. Se conserva por compatibilidad de
-- esquema, pero deja de estar disponible para clientes; la unica entrada publica es la Edge
-- Function recargar-wallet.
revoke execute on function public.recargar_saldo_demo (public.moneda_soportada, numeric)
from authenticated;

create or replace function public.aprovisionar_tesoreria_demo (
  p_public_key text,
  p_secret_key text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('paul:stellar-demo-treasury', 0));

  select jsonb_build_object(
    'public_key', t.public_key,
    'secret_key', s.decrypted_secret
  )
  into v_result
  from public.tesoreria_stellar_demo t
  join vault.decrypted_secrets s on s.id = t.secret_id
  where t.singleton;

  if v_result is not null then
    return v_result;
  end if;

  select vault.create_secret(p_secret_key, 'stellar_demo_treasury') into v_secret_id;

  insert into public.tesoreria_stellar_demo (singleton, public_key, secret_id)
  values (true, p_public_key, v_secret_id);

  return jsonb_build_object('public_key', p_public_key, 'secret_key', p_secret_key);
end;
$$;

create or replace function public.obtener_tesoreria_demo () returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'public_key', t.public_key,
    'secret_key', s.decrypted_secret
  )
  from public.tesoreria_stellar_demo t
  join vault.decrypted_secrets s on s.id = t.secret_id
  where t.singleton;
$$;

create or replace function public.reservar_recarga_wallet (
  p_investor_id uuid,
  p_moneda public.moneda_soportada,
  p_monto numeric,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_perfil record;
  v_existente public.recargas_saldo;
  v_tasa public.tipos_cambio_referencia;
  v_tasa_pen public.tipos_cambio_referencia;
  v_dia_lima date := ((now() at time zone 'America/Lima')::date);
  v_se_reinicia_at timestamptz := (((v_dia_lima + 1)::timestamp) at time zone 'America/Lima');
  v_tope_soles constant numeric := 1000.00;
  v_monto_equivalente_soles numeric;
  v_recargado_hoy numeric;
  v_recarga_id uuid;
  v_monto_xlm numeric;
begin
  if p_monto is null or p_monto <= 0 or p_idempotency_key is null then
    raise exception 'El monto y la clave de idempotencia son obligatorios.' using errcode = 'PA001';
  end if;

  select rol, wallet_public_key
  into v_perfil
  from public.perfiles
  where id = p_investor_id;

  if v_perfil.rol is distinct from 'inversionista' then
    raise exception 'Solo cuentas de inversionista pueden recargar.' using errcode = 'PA008';
  end if;

  if v_perfil.wallet_public_key is null then
    raise exception 'La billetera todavia se esta creando.' using errcode = 'PA007';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_investor_id::text || ':' || v_dia_lima::text, 0));

  select * into v_existente
  from public.recargas_saldo
  where investor_id = p_investor_id and idempotency_key = p_idempotency_key;

  if found then
    return jsonb_build_object(
      'recarga_id', v_existente.id,
      'wallet_public_key', v_perfil.wallet_public_key,
      'moneda', v_existente.moneda,
      'monto', v_existente.monto,
      'monto_xlm', v_existente.monto_xlm,
      'tx_hash', v_existente.tx_hash,
      'tx_xdr', v_existente.tx_xdr,
      'estado', v_existente.estado,
      'ya_existia', true
    );
  end if;

  select * into v_tasa from public.tipo_cambio_vigente(p_moneda);
  if v_tasa.tasa_moneda_por_xlm is null then
    raise exception 'Tipo de cambio de referencia no disponible.' using errcode = 'PA010';
  end if;

  v_monto_xlm := round(p_monto / v_tasa.tasa_moneda_por_xlm, 7);

  if p_moneda = 'PEN' then
    v_monto_equivalente_soles := p_monto;
  else
    select * into v_tasa_pen from public.tipo_cambio_vigente('PEN');
    if v_tasa_pen.tasa_moneda_por_xlm is null then
      raise exception 'Tipo de cambio de referencia no disponible.' using errcode = 'PA010';
    end if;
    v_monto_equivalente_soles := round(v_monto_xlm * v_tasa_pen.tasa_moneda_por_xlm, 2);
  end if;

  select coalesce(sum(monto_equivalente_soles), 0)
  into v_recargado_hoy
  from public.recargas_saldo
  where investor_id = p_investor_id
    and estado in ('reservada', 'confirmada')
    and (created_at at time zone 'America/Lima')::date = v_dia_lima;

  if v_monto_equivalente_soles > v_tope_soles - v_recargado_hoy then
    raise exception 'La recarga excede el tope diario de S/% (equivalente).', v_tope_soles
    using
      errcode = 'PA011',
      detail = jsonb_build_object(
        'disponible_para_recargar_hoy', greatest(v_tope_soles - v_recargado_hoy, 0),
        'tope_diario_equivalente_soles', v_tope_soles,
        'se_reinicia_at', v_se_reinicia_at
      )::text;
  end if;

  insert into public.recargas_saldo (
    investor_id,
    moneda,
    monto,
    monto_equivalente_soles,
    tipo_cambio_referencia_aplicado,
    idempotency_key,
    monto_xlm,
    estado,
    confirmada_at
  ) values (
    p_investor_id,
    p_moneda,
    p_monto,
    v_monto_equivalente_soles,
    v_tasa.tasa_moneda_por_xlm,
    p_idempotency_key,
    v_monto_xlm,
    'reservada',
    null
  ) returning id into v_recarga_id;

  return jsonb_build_object(
    'recarga_id', v_recarga_id,
    'wallet_public_key', v_perfil.wallet_public_key,
    'moneda', p_moneda,
    'monto', p_monto,
    'monto_xlm', v_monto_xlm,
    'estado', 'reservada',
    'ya_existia', false
  );
end;
$$;

create or replace function public.registrar_transaccion_recarga (
  p_recarga_id uuid,
  p_tx_hash text,
  p_tx_xdr text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recarga public.recargas_saldo;
begin
  select * into v_recarga from public.recargas_saldo where id = p_recarga_id for update;

  if v_recarga.estado <> 'reservada' then
    return jsonb_build_object('tx_hash', v_recarga.tx_hash, 'tx_xdr', v_recarga.tx_xdr);
  end if;

  if v_recarga.tx_hash is null then
    update public.recargas_saldo
    set tx_hash = p_tx_hash, tx_xdr = p_tx_xdr
    where id = p_recarga_id;
    return jsonb_build_object('tx_hash', p_tx_hash, 'tx_xdr', p_tx_xdr);
  end if;

  return jsonb_build_object('tx_hash', v_recarga.tx_hash, 'tx_xdr', v_recarga.tx_xdr);
end;
$$;

create or replace function public.confirmar_recarga_wallet (p_recarga_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recarga public.recargas_saldo;
  v_saldo numeric;
  v_recargado_hoy numeric;
  v_dia_lima date;
  v_tope_soles constant numeric := 1000.00;
  v_se_reinicia_at timestamptz;
begin
  select * into v_recarga from public.recargas_saldo where id = p_recarga_id for update;
  if not found then
    raise exception 'Recarga no encontrada.' using errcode = 'PA012';
  end if;

  if v_recarga.estado = 'revertida' then
    raise exception 'La recarga fue revertida.' using errcode = 'PA013';
  end if;

  if v_recarga.estado = 'reservada' then
    if v_recarga.tx_hash is null then
      raise exception 'La transaccion Stellar aun no fue registrada.' using errcode = 'PA013';
    end if;

    insert into public.saldos_demostracion (investor_id, moneda, saldo, updated_at)
    values (v_recarga.investor_id, v_recarga.moneda, v_recarga.monto, now())
    on conflict (investor_id, moneda) do update
    set saldo = public.saldos_demostracion.saldo + excluded.saldo, updated_at = now()
    returning saldo into v_saldo;

    update public.recargas_saldo
    set estado = 'confirmada', confirmada_at = now(), motivo_fallo = null
    where id = p_recarga_id;
  else
    select saldo into v_saldo
    from public.saldos_demostracion
    where investor_id = v_recarga.investor_id and moneda = v_recarga.moneda;
  end if;

  v_dia_lima := (v_recarga.created_at at time zone 'America/Lima')::date;
  v_se_reinicia_at := (((v_dia_lima + 1)::timestamp) at time zone 'America/Lima');

  select coalesce(sum(monto_equivalente_soles), 0)
  into v_recargado_hoy
  from public.recargas_saldo
  where investor_id = v_recarga.investor_id
    and estado = 'confirmada'
    and (created_at at time zone 'America/Lima')::date = v_dia_lima;

  return jsonb_build_object(
    'recarga_id', v_recarga.id,
    'saldo_actualizado', v_saldo,
    'moneda', v_recarga.moneda,
    'monto_xlm', v_recarga.monto_xlm,
    'tx_hash', v_recarga.tx_hash,
    'recargado_hoy_equivalente_soles', v_recargado_hoy,
    'tope_diario_equivalente_soles', v_tope_soles,
    'disponible_para_recargar_hoy', greatest(v_tope_soles - v_recargado_hoy, 0),
    'se_reinicia_at', v_se_reinicia_at
  );
end;
$$;

create or replace function public.revertir_recarga_wallet (
  p_recarga_id uuid,
  p_motivo text
) returns void
language sql
security definer
set search_path = ''
as $$
  update public.recargas_saldo
  set estado = 'revertida', motivo_fallo = p_motivo
  where id = p_recarga_id and estado = 'reservada';
$$;

revoke all on function public.aprovisionar_tesoreria_demo (text, text) from public, anon, authenticated;
revoke all on function public.obtener_tesoreria_demo () from public, anon, authenticated;
revoke all on function public.reservar_recarga_wallet (uuid, public.moneda_soportada, numeric, uuid) from public, anon, authenticated;
revoke all on function public.registrar_transaccion_recarga (uuid, text, text) from public, anon, authenticated;
revoke all on function public.confirmar_recarga_wallet (uuid) from public, anon, authenticated;
revoke all on function public.revertir_recarga_wallet (uuid, text) from public, anon, authenticated;

grant execute on function public.aprovisionar_tesoreria_demo (text, text) to service_role;
grant execute on function public.obtener_tesoreria_demo () to service_role;
grant execute on function public.reservar_recarga_wallet (uuid, public.moneda_soportada, numeric, uuid) to service_role;
grant execute on function public.registrar_transaccion_recarga (uuid, text, text) to service_role;
grant execute on function public.confirmar_recarga_wallet (uuid) to service_role;
grant execute on function public.revertir_recarga_wallet (uuid, text) to service_role;
