-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- Hallazgo real durante la validación de quickstart.md §8 (concurrencia): dos aportes
-- confirmados en paralelo sobre el mismo tramo disparan dos invocaciones concurrentes de `mint`
-- firmadas con la MISMA cuenta `operador_authority` (compartida por toda la plataforma). Stellar
-- solo admite una transacción "en vuelo" por número de secuencia de cuenta — la segunda
-- invocación colisiona (secuencia obsoleta) y falla. Si además la compensación (reembolso XLM
-- desde la custodia del pool) se dispara en paralelo para dos aportes del mismo pool, ambos
-- reembolsos firman con la MISMA cuenta de custodia y pueden colisionar igual, dejando un aporte
-- en 'reservado' sin mint y sin reembolso (violación real de la garantía "nunca queda pendiente").
-- Reproducido y reconciliado a mano contra testnet (6 llamadas concurrentes de confirmar-aporte
-- sobre un cupo ajustado a 3 fracciones): 3 reservas pasaron el guard atómico de cupo, pero las 3
-- invocaciones de mint chocaron entre sí; 2 de los 3 reembolsos de compensación también chocaron
-- entre sí (colisión de secuencia en la cuenta de custodia), dejando un aporte con pago XLM real
-- ya hecho pero sin fracciones ni reembolso hasta la reconciliación manual.
--
-- Corrección: un lock de aplicación por cuenta firmante (operador_authority, custodia de cada
-- pool, wallet de cada inversionista), respaldado en Postgres, que serializa el tramo
-- cargar-secuencia -> firmar -> someter de cualquier cuenta Stellar compartida entre invocaciones
-- concurrentes de Edge Functions (que no comparten memoria entre sí). Con TTL corto: si una
-- invocación muere sin liberar el lock, expira sola y no bloquea el resto de la demo.
create table if not exists public.lock_firma_stellar (
  cuenta_publica text primary key,
  locked_until timestamptz not null
);

comment on table public.lock_firma_stellar is
  'Lock de aplicación (no de Postgres) para serializar firmas concurrentes de una misma cuenta Stellar (secuencia de cuenta) entre invocaciones paralelas de Edge Functions. Solo service_role.';

revoke all on table public.lock_firma_stellar
from
  public,
  anon,
  authenticated;

create or replace function public.adquirir_lock_firma (
  p_cuenta_publica text,
  p_ttl_segundos integer default 30
) returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_adquirido boolean;
begin
  insert into public.lock_firma_stellar (cuenta_publica, locked_until)
  values (p_cuenta_publica, now() + make_interval(secs => p_ttl_segundos))
  on conflict (cuenta_publica) do update
    set locked_until = excluded.locked_until
    where public.lock_firma_stellar.locked_until < now()
  returning true into v_adquirido;

  return coalesce(v_adquirido, false);
end;
$$;

comment on function public.adquirir_lock_firma (text, integer) is
  'Intenta tomar el lock de una cuenta Stellar; true si se adquirió (libre o expirado), false si ya está en uso. Una sola sentencia atómica, segura bajo llamadas concurrentes.';

revoke all on function public.adquirir_lock_firma (text, integer)
from
  public,
  anon,
  authenticated;

grant
execute on function public.adquirir_lock_firma (text, integer) to service_role;

create or replace function public.liberar_lock_firma (p_cuenta_publica text) returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.lock_firma_stellar where cuenta_publica = p_cuenta_publica;
$$;

revoke all on function public.liberar_lock_firma (text)
from
  public,
  anon,
  authenticated;

grant
execute on function public.liberar_lock_firma (text) to service_role;
