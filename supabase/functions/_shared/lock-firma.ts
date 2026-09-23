// Feature: Originación de Facturas y Tokenización de Fracciones de Pool
// (specs/20260920-174938-originacion-facturas-pool)
//
// Hallazgo real durante la validación de quickstart.md §8 (concurrencia): dos confirmar-aporte
// concurrentes sobre el mismo tramo invocan `mint` firmando con la MISMA cuenta
// `operador_authority` (compartida por toda la plataforma); Stellar solo admite una transacción
// "en vuelo" por número de secuencia de cuenta, así que la segunda colisiona y falla. Lo mismo le
// pasa a dos reembolsos de compensación del mismo pool (misma cuenta de custodia). Reproducido
// contra testnet: de 3 reservas válidas sobre el mismo tramo, las 3 invocaciones de mint
// chocaron entre sí, y 2 de los 3 reembolsos de compensación TAMBIÉN chocaron entre sí — un
// aporte quedó con el pago XLM ya hecho pero sin fracciones ni reembolso hasta reconciliarlo a
// mano (ver migración 0016_lock_firma_stellar.sql).
//
// Las Edge Functions no comparten memoria entre invocaciones concurrentes (cada una puede correr
// en un isolate/instancia distinta), así que un mutex en proceso no sirve — el lock tiene que
// vivir en Postgres. `adquirir_lock_firma`/`liberar_lock_firma` (0016) son una sola sentencia
// atómica cada una (INSERT ... ON CONFLICT ... WHERE), segura bajo llamadas concurrentes.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const ESPERA_MAXIMA_MS = 40_000;
const REINTENTO_MIN_MS = 300;
const REINTENTO_MAX_MS = 700;

/**
 * Ejecuta `fn` mientras sostiene el lock de aplicación de `cuentaPublica` (la cuenta Stellar que
 * va a firmar dentro de `fn`), esperando hasta `ESPERA_MAXIMA_MS` si otra invocación concurrente
 * ya lo tiene. Libera el lock siempre, incluso si `fn` lanza. Sin este lock, dos invocaciones
 * concurrentes que firman con la misma cuenta chocan por número de secuencia (ver arriba).
 */
export async function conLockFirma<T>(
  supabase: SupabaseClient,
  cuentaPublica: string,
  fn: () => Promise<T>,
  ttlSegundos = 30,
): Promise<T> {
  const inicio = Date.now();
  let adquirido = false;

  while (Date.now() - inicio < ESPERA_MAXIMA_MS) {
    const { data, error } = await supabase.rpc("adquirir_lock_firma", {
      p_cuenta_publica: cuentaPublica,
      p_ttl_segundos: ttlSegundos,
    });
    if (error) {
      throw new Error(`lock_firma_error: ${error.message}`);
    }
    if (data === true) {
      adquirido = true;
      break;
    }
    const espera = REINTENTO_MIN_MS + Math.random() * (REINTENTO_MAX_MS - REINTENTO_MIN_MS);
    await new Promise((r) => setTimeout(r, espera));
  }

  if (!adquirido) {
    throw new Error(`timeout_lock_firma: ${cuentaPublica}`);
  }

  try {
    return await fn();
  } finally {
    await supabase.rpc("liberar_lock_firma", { p_cuenta_publica: cuentaPublica });
  }
}
