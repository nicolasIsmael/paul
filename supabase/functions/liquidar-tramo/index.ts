// Liquidacion de Tramo: pago real en XLM y quema de fracciones en Stellar Testnet.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { pagarXlm } from "../_shared/stellar-payment.ts";
import {
  consultarSoloLectura,
  invocarContratoAdminConReintentos,
} from "../_shared/stellar-soroban.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ErrorApi = { code: string; message: string; [extra: string]: unknown };
type InversionistaPendiente = { investor_id: string; wallet_public_key: string | null };
type ResultadoInversionista = {
  investor_id: string;
  fracciones: number;
  monto_pagado: number;
  estado: "pagado" | "compensado";
  motivo?: string;
  tx_hash_pago?: string;
  tx_hash_quema?: string;
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

function errorDesdeSupabase(err: { code?: string; message: string }): ErrorApi {
  return { code: err.code ?? "PA013", message: err.message };
}

async function registrarPagado(
  resultados: ResultadoInversionista[],
  tramoId: string,
  investorId: string,
  fracciones: number,
  monto: number,
  moneda: string,
  txPago: string | null,
  txQuema: string | null,
): Promise<void> {
  const { error } = await supabaseService.rpc("registrar_pago_liquidacion", {
    p_tramo_id: tramoId,
    p_investor_id: investorId,
    p_fracciones: fracciones,
    p_monto: monto,
    p_moneda: moneda,
    p_tx_pago: txPago,
    p_tx_quema: txQuema,
  });
  if (error) throw new Error(`No se pudo registrar el pago: ${error.message}`);
  resultados.push({
    investor_id: investorId,
    fracciones,
    monto_pagado: monto,
    estado: "pagado",
    ...(txPago ? { tx_hash_pago: txPago } : {}),
    ...(txQuema ? { tx_hash_quema: txQuema } : {}),
  });
}

async function registrarCompensado(
  resultados: ResultadoInversionista[],
  tramoId: string,
  investorId: string,
  fracciones: number,
  monto: number,
  moneda: string,
  motivo: string,
  txPago: string | null = null,
  txQuema: string | null = null,
): Promise<void> {
  const { error } = await supabaseService.rpc("registrar_liquidacion_compensada", {
    p_tramo_id: tramoId,
    p_investor_id: investorId,
    p_fracciones: fracciones,
    p_monto: monto,
    p_moneda: moneda,
    p_motivo: motivo,
    p_tx_hash_pago: txPago,
    p_tx_hash_quema: txQuema,
  });
  if (error) throw new Error(`No se pudo registrar la compensacion: ${error.message}`);
  resultados.push({
    investor_id: investorId,
    fracciones,
    monto_pagado: monto,
    estado: "compensado",
    motivo,
    ...(txPago ? { tx_hash_pago: txPago } : {}),
    ...(txQuema ? { tx_hash_quema: txQuema } : {}),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return respuestaError({ code: "PA012", message: "Metodo no permitido." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return respuestaError({ code: "PA008", message: "Falta autenticacion." }, 401);

    const supabaseUsuario = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userError } = await supabaseUsuario.auth.getUser();
    if (userError || !userData?.user) {
      return respuestaError({ code: "PA008", message: "Sesion invalida o expirada." }, 401);
    }

    let body: { tramo_id?: string; idempotency_key?: string };
    try {
      body = await req.json();
    } catch {
      return respuestaError({ code: "PA012", message: "Cuerpo de la solicitud invalido." }, 400);
    }
    if (!body.tramo_id || !body.idempotency_key) {
      return respuestaError(
        { code: "PA012", message: "tramo_id e idempotency_key son obligatorios." },
        400,
      );
    }

    const tramoId = body.tramo_id;
    const intentoId = body.idempotency_key;
    const { data: perfil, error: perfilError } = await supabaseService
      .from("perfiles")
      .select("rol")
      .eq("id", userData.user.id)
      .single();
    if (perfilError || !perfil || perfil.rol !== "operador_banco") {
      return respuestaError(
        { code: "PA008", message: "Solo el operador de banco puede liquidar un tramo." },
        403,
      );
    }

    const { data: inicio, error: inicioError } = await supabaseService.rpc(
      "iniciar_liquidacion_tramo",
      { p_tramo_id: tramoId, p_intento_id: intentoId },
    );
    if (inicioError) return respuestaError(errorDesdeSupabase(inicioError), 400);

    const inversionistas = (inicio.inversionistas ?? []) as InversionistaPendiente[];
    const resultados: ResultadoInversionista[] = [];

    // Un tramo sin aportes se puede cerrar sin exigir contrato ni custodia (FR-009).
    if (inversionistas.length === 0) {
      const { error } = await supabaseService.rpc("finalizar_liquidacion_tramo", {
        p_tramo_id: tramoId,
        p_intento_id: intentoId,
      });
      if (error) return respuestaError(errorDesdeSupabase(error), 409);
      return new Response(
        JSON.stringify({ ok: true, tramo_id: tramoId, estado_liquidacion: "liquidado", resultados }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
      );
    }

    const { data: tramo, error: tramoError } = await supabaseService
      .from("tramos")
      .select("pool_id, token_contract_id, rendimiento_ilustrativo_plazo_pct")
      .eq("id", tramoId)
      .single();
    if (tramoError || !tramo?.token_contract_id) {
      return respuestaError(
        { code: "PA019", message: "El tramo no tiene un contrato asociado." },
        400,
      );
    }

    const [{ data: pool, error: poolError }, { data: secretoCustodia, error: secretoCustodiaError }] =
      await Promise.all([
        supabaseService
          .from("pools")
          .select("unidad_minima_aporte, custody_public_key, moneda")
          .eq("id", tramo.pool_id)
          .single(),
        supabaseService.rpc("obtener_secreto_custodia_pool", { p_pool_id: tramo.pool_id }),
      ]);
    if (poolError || !pool?.custody_public_key || secretoCustodiaError || !secretoCustodia) {
      return respuestaError(
        { code: "PA019", message: "No se pudo obtener la wallet de custodia del pool." },
        500,
      );
    }

    const { data: tasaMonedaPorXlm, error: tasaError } = await supabaseService.rpc(
      "obtener_tasa_cambio_liquidacion",
      { p_moneda: pool.moneda },
    );
    if (tasaError || !tasaMonedaPorXlm) {
      return respuestaError(
        { code: "PA010", message: "No hay tipo de cambio vigente para liquidar este pool." },
        400,
      );
    }

    for (const inv of inversionistas) {
      if (!inv.wallet_public_key) {
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, "sin_wallet_publica",
        );
        continue;
      }
      let fracciones: number;
      try {
        fracciones = Number(await consultarSoloLectura(tramo.token_contract_id, "balance", [
          { type: "address", value: inv.wallet_public_key },
        ]));
      } catch {
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, "fallo_lectura_balance",
        );
        continue;
      }

      if (!Number.isSafeInteger(fracciones) || fracciones < 0) {
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, "balance_onchain_invalido",
        );
        continue;
      }
      if (fracciones === 0) {
        await registrarPagado(resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, null, null);
        continue;
      }

      const monto = Math.round(
        fracciones * Number(pool.unidad_minima_aporte) *
          (1 + Number(tramo.rendimiento_ilustrativo_plazo_pct) / 100) * 100,
      ) / 100;
      const montoXlm = Math.round((monto / Number(tasaMonedaPorXlm)) * 1e7) / 1e7;
      const { data: secretoInversionista, error: secretoInvError } = await supabaseService.rpc(
        "obtener_secreto_wallet",
        { perfil_id: inv.investor_id },
      );
      if (secretoInvError || !secretoInversionista) {
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda, "sin_secreto_wallet",
        );
        continue;
      }

      let txPago: string;
      try {
        ({ hash: txPago } = await pagarXlm(
          supabaseService,
          secretoCustodia,
          inv.wallet_public_key,
          montoXlm,
        ));
      } catch {
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda, "fallo_pago_xlm",
        );
        continue;
      }

      try {
        const { hash: txQuema } = await invocarContratoAdminConReintentos(
          supabaseService,
          secretoInversionista,
          tramo.token_contract_id,
          "burn",
          [
            { type: "address", value: inv.wallet_public_key },
            { type: "i128", value: fracciones },
          ],
        );
        await registrarPagado(
          resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda, txPago, txQuema,
        );
      } catch (error) {
        console.error("Fallo al quemar fracciones; se intentara revertir el pago", {
          tramoId,
          investorId: inv.investor_id,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await pagarXlm(supabaseService, secretoInversionista, pool.custody_public_key, montoXlm);
        } catch {
          await registrarCompensado(
            resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda,
            "fallo_quema_onchain_y_reembolso", txPago, null,
          );
          continue;
        }
        await registrarCompensado(
          resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda,
          "fallo_quema_onchain", txPago, null,
        );
      }
    }

    const { error: cierreError } = await supabaseService.rpc("finalizar_liquidacion_tramo", {
      p_tramo_id: tramoId,
      p_intento_id: intentoId,
    });
    if (cierreError) return respuestaError(errorDesdeSupabase(cierreError), 409);

    return new Response(
      JSON.stringify({ ok: true, tramo_id: tramoId, estado_liquidacion: "liquidado", resultados }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error no controlado al liquidar tramo", error);
    return respuestaError(
      { code: "PA013", message: "No se pudo completar la liquidacion. Puedes reanudarla." },
      500,
    );
  }
});
