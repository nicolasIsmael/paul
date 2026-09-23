// Feature: Exploración de Pools y Primer Aporte del Inversionista
// (specs/20260920-113925-inversion-pools-aporte)
// T035: orquesta de forma SÍNCRONA reserva (cupo+saldo, una transacción de base) -> pago en XLM
// testnet -> confirmación con el hash, o reversión si falla — nunca deja el aporte pendiente de
// cara al cliente (FR-034). Invocada directamente por el cliente autenticado. Desplegada con
// verify_jwt=true. Contrato completo: contracts/confirmar-aporte-function.md.
//
// EXTENSIÓN (specs/20260920-174938-originacion-facturas-pool, T042): entre el pago XLM y la
// confirmación se inserta la emisión de fracciones on-chain (mint), con reintentos acotados y
// compensación automática (reembolso XLM) si el contrato falla de forma definitiva — el contrato
// manda (research.md §2). Ver contracts/confirmar-aporte-extension.md.
//
// El paso de mint comparte `_shared/stellar-soroban.ts` con `asignar-factura`, verificado en vivo
// contra testnet (T050) — mismo helper, mismas correcciones (ver ese archivo).
//
// Verificado en vivo contra testnet (validación de quickstart.md §8, concurrencia): tanto el pago
// (`pagarXlm`) como el mint (`invocarContratoAdminConReintentos`) ahora exigen `supabaseService`
// y sostienen `_shared/lock-firma.ts` mientras firman — dos aportes confirmándose en paralelo
// firman con la MISMA cuenta compartida (operador_authority para el mint; la custodia del pool
// para el reembolso de compensación) y chocaban por número de secuencia de cuenta sin este lock,
// dejando en un caso real un aporte con el pago ya hecho pero sin fracciones ni reembolso hasta
// reconciliarlo a mano (ver 0016_lock_firma_stellar.sql).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { obtenerBalanceXlm, pagarXlm } from "../_shared/stellar-payment.ts";
import {
  consultarSoloLectura,
  invocarContratoAdminConReintentos,
} from "../_shared/stellar-soroban.ts";

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
  cotizacion_id: string;
  monto_nominal: number;
  moneda: string;
  xlm_pagados: number | null;
  tipo_cambio_aplicado: number;
  tx_hash: string | null;
  fraccion_tx_hash: string | null;
  comprobante_simulado: boolean;
  estado: "reservado" | "confirmado" | "revertido";
  motivo_reversion: string | null;
  confirmado_at: string | null;
};

const supabaseService: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function respuestaError(error: ErrorApi, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
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
        fraccion_tx_hash: aporte.fraccion_tx_hash,
        red: "stellar-testnet",
        simulado: aporte.comprobante_simulado,
      },
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
}

async function leerAporte(aporteId: string): Promise<Aporte | null> {
  const { data } = await supabaseService.from("aportes").select("*").eq("id", aporteId).single<Aporte>();
  return data ?? null;
}

async function asegurarCapContrato(
  secretoAdmin: string,
  tramoId: string,
  contractId: string,
  fraccionesTotales: number,
): Promise<void> {
  const leerCap = async () => Number(await consultarSoloLectura(contractId, "cap"));
  if (await leerCap() >= fraccionesTotales) return;

  const semilla = new TextEncoder().encode(
    `paul:backfill-cap:${tramoId}:${fraccionesTotales}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", semilla));
  const huella = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

  try {
    await invocarContratoAdminConReintentos(
      supabaseService,
      secretoAdmin,
      contractId,
      "register_invoice",
      [
        { type: "bytes32", value: huella },
        { type: "i128", value: fraccionesTotales },
      ],
    );
  } catch (error) {
    // Otra invocacion concurrente pudo sincronizar el mismo contrato mientras esperabamos el
    // lock de firma. Solo propagar si el cap continua realmente desactualizado.
    if (await leerCap() < fraccionesTotales) throw error;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return respuestaError({ code: "PA008", message: "Falta autenticación." }, 401);
  }

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

  // Paso 1: validar rol inversionista — defensa en profundidad.
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

  // Paso 2: reservar (cupo + saldo, una sola transacción de base — research.md §1 de la spec
  // previa). Si falla, responde de inmediato sin tocar la red Stellar.
  const { data: reserva, error: reservaError } = await supabaseService.rpc("reservar_aporte", {
    p_cotizacion_id: body.cotizacion_id,
    p_investor_id: investorId,
    p_idempotency_key: body.idempotency_key,
  });

  if (reservaError) {
    return respuestaError(errorDesdeSupabase(reservaError), 400);
  }

  const aporteId: string = reserva.aporte_id;
  let aporte = await leerAporte(aporteId);
  if (!aporte) {
    return respuestaError({ code: "PA013", message: "No se pudo leer el aporte recién reservado/existente." }, 500);
  }

  // Reintento de un aporte ya resuelto (confirmado o revertido) — devolver el resultado ya
  // conocido, sin repetir nada (FR-027 de la spec previa).
  if (aporte.estado === "confirmado") {
    return respuestaDesdeAporte(aporte);
  }
  if (aporte.estado === "revertido") {
    return respuestaError(
      { code: aporte.motivo_reversion === "fallo_emision_fracciones" ? "PA019" : "PA013", message: "Este aporte ya fue revertido." },
      400,
    );
  }

  // A partir de aquí, aporte.estado === 'reservado' — puede ser la primera vez, o un reintento
  // tras un fallo a mitad de camino (pago hecho pero mint pendiente, o ninguno de los dos).
  const { data: cotizacion } = await supabaseService
    .from("cotizaciones")
    .select("monto_xlm")
    .eq("id", aporte.cotizacion_id)
    .single();
  const montoXlm = Number(cotizacion?.monto_xlm);

  const [{ data: secretoWallet, error: secretoError }, { data: pool }] = await Promise.all([
    supabaseService.rpc("obtener_secreto_wallet", { perfil_id: investorId }),
    supabaseService
      .from("pools")
      .select("custody_public_key, unidad_minima_aporte")
      .eq("id", aporte.pool_id)
      .single(),
  ]);

  if (secretoError || !secretoWallet || !pool?.custody_public_key) {
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "otro" });
    return respuestaError(
      { code: "PA013", message: "No se pudo preparar el pago (billetera o custodia no lista)." },
      500,
    );
  }

  // Paso 3 (solo si el pago aún no se hizo): chequear reserva mínima + pagar en XLM.
  if (!aporte.tx_hash) {
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

    try {
      const { hash } = await pagarXlm(supabaseService, secretoWallet, pool.custody_public_key, montoXlm);
      // Se guarda el hash de inmediato (vía confirmar_aporte con simulado=false lo dejaría en
      // 'confirmado' antes de mintear — en su lugar se registra el pago crudo con un UPDATE
      // directo, y confirmar_aporte se reserva para el final, tras el mint).
      await supabaseService.from("aportes").update({ tx_hash: hash }).eq("id", aporteId);
      aporte = await leerAporte(aporteId) ?? aporte;
    } catch (err) {
      await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: "fallo_red_stellar" });
      return respuestaError(
        { code: "PA013", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
  }

  // Paso 4 (Historia 3 de originación-facturas-pool): emitir fracciones on-chain, salvo que ya
  // se haya hecho en un intento previo (idempotencia del mint, research.md §2).
  if (!aporte.fraccion_tx_hash) {
    const { data: tramo } = await supabaseService
      .from("tramos")
      .select("token_contract_id, fracciones_totales")
      .eq("id", aporte.tramo_id)
      .single();
    const { data: secretoAdmin } = await supabaseService.rpc("obtener_secreto_autoridad_operador", {
      p_red: "testnet",
    });

    if (!tramo?.token_contract_id || !secretoAdmin) {
      return await compensarYResponder(
        aporteId,
        aporte,
        perfil.wallet_public_key,
        montoXlm,
        "otro",
      );
    }

    // La cantidad de fracciones a mintear es siempre un entero exacto: cotizar_aporte (spec
    // previa, PA001) ya garantiza que monto_nominal es múltiplo de unidad_minima_aporte.
    const fracciones = aporte.monto_nominal / pool.unidad_minima_aporte;

    try {
      await asegurarCapContrato(
        secretoAdmin,
        aporte.tramo_id,
        tramo.token_contract_id,
        Number(tramo.fracciones_totales),
      );
      const { hash: fraccionHash } = await invocarContratoAdminConReintentos(
        supabaseService,
        secretoAdmin,
        tramo.token_contract_id,
        "mint",
        [
          { type: "address", value: perfil.wallet_public_key },
          { type: "i128", value: fracciones },
        ],
      );
      await supabaseService.from("aportes").update({ fraccion_tx_hash: fraccionHash }).eq("id", aporteId);
      aporte = await leerAporte(aporteId) ?? aporte;
    } catch (err) {
      console.error("Fallo al sincronizar el cap o emitir fracciones", {
        aporteId,
        tramoId: aporte.tramo_id,
        contractId: tramo.token_contract_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return await compensarYResponder(
        aporteId,
        aporte,
        perfil.wallet_public_key,
        montoXlm,
        "fallo_emision_fracciones",
        err,
      );
    }
  }

  // Paso 5: todo listo (pago + fracciones) — confirmar de forma definitiva.
  await supabaseService.rpc("confirmar_aporte", {
    p_aporte_id: aporteId,
    p_tx_hash: aporte.tx_hash,
    p_simulado: false,
  });

  const aporteConfirmado = await leerAporte(aporteId);
  if (!aporteConfirmado) {
    return respuestaError({ code: "PA013", message: "El aporte se confirmó pero no se pudo leer de vuelta." }, 500);
  }

  return respuestaDesdeAporte(aporteConfirmado);
});

/**
 * Compensación (research.md §2): reembolsa el pago XLM ya hecho desde la custodia del pool de
 * vuelta a la wallet del inversionista, firmado con la llave de custodia del pool — solo después
 * revierte la reserva (cupo + saldo) y responde el resultado final. Si el propio reembolso falla,
 * NO revierte (deja el aporte en 'reservado' para reconciliación manual — límite conocido,
 * plan.md → Riesgos) y responde PA013.
 */
async function compensarYResponder(
  aporteId: string,
  aporte: Aporte,
  investorPublicKey: string,
  montoXlm: number,
  motivo: "fallo_emision_fracciones" | "otro",
  errorOriginal?: unknown,
): Promise<Response> {
  if (!aporte.tx_hash) {
    // Nunca se llegó a pagar — no hay nada que compensar, revertir directamente.
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: motivo });
    return respuestaError(
      { code: "PA019", message: errorOriginal instanceof Error ? errorOriginal.message : "No se pudieron emitir las fracciones on-chain." },
      400,
    );
  }

  const { data: secretoCustodia, error: secretoCustodiaError } = await supabaseService.rpc(
    "obtener_secreto_custodia_pool",
    { p_pool_id: aporte.pool_id },
  );

  if (secretoCustodiaError || !secretoCustodia) {
    // No se puede compensar sin el secreto de custodia — se deja el aporte 'reservado' a
    // propósito (nunca revertir sin haber devuelto el dinero) para reconciliación manual.
    return respuestaError(
      { code: "PA013", message: "No se pudieron emitir las fracciones y tampoco se pudo compensar automáticamente el pago ya realizado." },
      500,
    );
  }

  try {
    const { hash: reembolsoHash } = await pagarXlm(supabaseService, secretoCustodia, investorPublicKey, montoXlm);
    await supabaseService.rpc("revertir_aporte", { p_aporte_id: aporteId, p_motivo: motivo });
    return respuestaError(
      {
        code: "PA019",
        message: "No se pudieron emitir las fracciones on-chain; el pago se revirtió automáticamente.",
      },
      400,
      { reembolso: { tx_hash: reembolsoHash, red: "stellar-testnet" } },
    );
  } catch {
    return respuestaError(
      { code: "PA013", message: "No se pudieron emitir las fracciones y el reembolso automático también falló. Requiere reconciliación manual." },
      500,
    );
  }
}
