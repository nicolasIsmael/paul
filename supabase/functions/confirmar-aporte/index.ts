// Feature: Exploración de Pools y Primer Aporte del Inversionista
// (specs/20260920-113925-inversion-pools-aporte)
// T035: orquesta de forma SÍNCRONA reserva (cupo+saldo, una transacción de base) -> pago en XLM
// testnet -> confirmación con el hash, o reversión si falla — nunca deja el aporte pendiente de
// cara al cliente (FR-034). Invocada directamente por el cliente autenticado (a diferencia de las
// otras dos Edge Functions de esta feature, que solo invoca un Database Webhook). Desplegada con
// verify_jwt=true (config.toml [functions.confirmar-aporte]) — el propio JWT del inversionista
// autentica la llamada. Contrato completo: contracts/confirmar-aporte-function.md.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { obtenerBalanceXlm, pagarXlm } from "../_shared/stellar-payment.ts";

const RESERVA_MINIMA_XLM = 2;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ErrorApi = { code: string; message: string; [extra: string]: unknown };

type Aporte = {
  id: string;
  pool_id: string;
  tramo_id: string;
  monto_nominal: number;
  moneda: string;
  xlm_pagados: number | null;
  tipo_cambio_aplicado: number;
  tx_hash: string | null;
  comprobante_simulado: boolean;
  estado: string;
  confirmado_at: string | null;
};

const supabaseService: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function respuestaError(error: ErrorApi, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorDesdeSupabase(err: { code?: string; message: string; details?: string | null }): ErrorApi {
  let extra: Record<string, unknown> = {};
  if (err.details) {
    try {
      extra = JSON.parse(err.details);
    } catch {
      // DETAIL de texto libre (no JSON) — se ignora, el mensaje ya explica el motivo.
    }
  }
  return { code: err.code ?? "PA013", message: err.message, ...extra };
}

function respuestaDesdeAporte(aporte: Aporte): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      aporte: {
        id: aporte.id,
        pool_id: aporte.pool_id,
        tramo_id: aporte.tramo_id,
        monto_nominal: aporte.monto_nominal,
        moneda: aporte.moneda,
        xlm_pagados: aporte.xlm_pagados,
        tipo_cambio_aplicado: aporte.tipo_cambio_aplicado,
        confirmado_at: aporte.confirmado_at,
      },
      comprobante: {
        tx_hash: aporte.tx_hash,
        red: "stellar-testnet",
        simulado: aporte.comprobante_simulado,
      },
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return respuestaError({ code: "PA008", message: "Falta autenticación." }, 401);
  }

  // Cliente "como el usuario" únicamente para resolver su identidad a partir del JWT.
  const supabaseUsuario = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: userData, error: userError } = await supabaseUsuario.auth.getUser();
  if (userError || !userData?.user) {
    return respuestaError({ code: "PA008", message: "Sesión inválida o expirada." }, 401);
  }
  const investorId = userData.user.id;

  let body: { cotizacion_id?: string; idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return respuestaError({ code: "PA012", message: "Cuerpo de la solicitud inválido." }, 400);
  }

  if (!body.cotizacion_id || !body.idempotency_key) {
    return respuestaError(
      { code: "PA012", message: "cotizacion_id e idempotency_key son obligatorios." },
      400,
    );
  }

  // Paso 1: validar rol inversionista — defensa en profundidad (reservar_aporte confía en que
  // solo esta función la invoca vía service_role).
  const { data: perfil, error: perfilError } = await supabaseService
    .from("perfiles")
    .select("rol, wallet_public_key, wallet_secret_id")
    .eq("id", investorId)
    .single();

  if (perfilError || !perfil || perfil.rol !== "inversionista") {
    return respuestaError(
      { code: "PA008", message: "Solo cuentas de inversionista pueden aportar." },
      403,
    );
  }

  if (!perfil.wallet_public_key) {
    return respuestaError(
      { code: "PA007", message: "La billetera todavía se está creando." },
      400,
    );
  }

  // Paso 2: reservar (cupo + saldo, una sola transacción de base — research.md §1). Si falla,
  // responde de inmediato sin tocar la red Stellar.
  const { data: reserva, error: reservaError } = await supabaseService.rpc("reservar_aporte", {
    p_cotizacion_id: body.cotizacion_id,
    p_investor_id: investorId,
    p_idempotency_key: body.idempotency_key,
  });

  if (reservaError) {
    return respuestaError(errorDesdeSupabase(reservaError), 400);
  }

  const aporteId: string = reserva.aporte_id;

  if (reserva.ya_existia) {
    // Reintento/doble clic (FR-027): devolver el resultado ya conocido, sin repetir el pago.
    const { data: aporteExistente } = await supabaseService
      .from("aportes")
      .select("*")
      .eq("id", aporteId)
      .single<Aporte>();
    if (aporteExistente) return respuestaDesdeAporte(aporteExistente);
  }

  const montoXlm = Number(reserva.monto_xlm);

  // Paso 3: leer el secreto de la billetera del inversionista y la custodia del pool.
  const [{ data: secretoWallet, error: secretoError }, { data: pool }] = await Promise.all([
    supabaseService.rpc("obtener_secreto_wallet", { perfil_id: investorId }),
    supabaseService.from("pools").select("custody_public_key").eq("id", reserva.pool_id).single(),
  ]);

  if (secretoError || !secretoWallet || !pool?.custody_public_key) {
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "otro" });
    return respuestaError(
      { code: "PA013", message: "No se pudo preparar el pago (billetera o custodia no lista)." },
      500,
    );
  }

  // Paso 4: chequear la reserva mínima de 2 XLM contra el balance real de la billetera antes de
  // pagar — nunca confiar solo en que Horizon rechace la transacción (Clarifications de spec.md).
  let balanceActual: number;
  try {
    balanceActual = await obtenerBalanceXlm(perfil.wallet_public_key);
  } catch {
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "fallo_red_stellar" });
    return respuestaError(
      { code: "PA013", message: "No se pudo consultar el balance de la billetera en Horizon." },
      502,
    );
  }

  if (balanceActual - montoXlm < RESERVA_MINIMA_XLM) {
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "xlm_insuficiente" });
    return respuestaError(
      {
        code: "PA009",
        message: "La billetera no tiene XLM suficiente para cubrir el pago y la reserva mínima de 2 XLM.",
      },
      400,
    );
  }

  // Paso 5: someter el pago. Éxito -> confirmar_aporte; fallo -> revertir_aporte (PA013).
  try {
    const { hash } = await pagarXlm(secretoWallet, pool.custody_public_key, montoXlm);
    await supabaseService.rpc("confirmar_aporte", {
      p_aporte_id: aporteId,
      p_tx_hash: hash,
      p_simulado: false,
    });
  } catch (err) {
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "fallo_red_stellar" });
    return respuestaError(
      { code: "PA013", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  const { data: aporteConfirmado } = await supabaseService
    .from("aportes")
    .select("*")
    .eq("id", aporteId)
    .single<Aporte>();

  if (!aporteConfirmado) {
    return respuestaError({ code: "PA013", message: "El aporte se confirmó pero no se pudo leer de vuelta." }, 500);
  }

  return respuestaDesdeAporte(aporteConfirmado);
});
