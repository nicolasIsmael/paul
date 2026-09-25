// Feature: Liquidación de Tramo (Cobro Simulado, Camino Feliz)
// (specs/20260925-002004-liquidacion-tramo)
// T010-T020: orquesta, para cada inversionista con fracciones reales en el tramo, el pago real en
// XLM (custodia -> inversionista) seguido de la quema de esas fracciones en el contrato,
// firmando con la propia llave del inversionista (burn exige from.require_auth() —
// contracts/soroban-pool/src/lib.rs). Cada inversionista se procesa de forma independiente: un
// fallo puntual se compensa solo a esa persona (research.md §3), el resto del tramo sigue.
// Invocada directamente por el cliente autenticado (operador de banco), verify_jwt=true.
// Contrato completo: contracts/liquidar-tramo-function.md.
//
// No se toca el contrato Soroban ni ningún archivo existente — reutiliza tal cual pagarXlm,
// consultarSoloLectura e invocarContratoAdminConReintentos (research.md §2, §5).

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

type InversionistaPendiente = { investor_id: string; wallet_public_key: string };

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

// T017-T019: registra el resultado de un inversionista (pagado o compensado) y lo agrega al
// arreglo de resultados que finalmente ve el operador.
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
  await supabaseService.rpc("registrar_pago_liquidacion", {
    p_tramo_id: tramoId,
    p_investor_id: investorId,
    p_fracciones: fracciones,
    p_monto: monto,
    p_moneda: moneda,
    p_tx_pago: txPago,
    p_tx_quema: txQuema,
  });
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
  await supabaseService.rpc("registrar_liquidacion_compensada", {
    p_tramo_id: tramoId,
    p_investor_id: investorId,
    p_fracciones: fracciones,
    p_monto: monto,
    p_moneda: moneda,
    p_motivo: motivo,
    p_tx_hash_pago: txPago,
    p_tx_hash_quema: txQuema,
  });
  resultados.push({
    investor_id: investorId,
    fracciones,
    monto_pagado: monto,
    estado: "compensado",
    motivo,
  });
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
  const operadorId = userData.user.id;

  let body: { tramo_id?: string };
  try {
    body = await req.json();
  } catch {
    return respuestaError({ code: "PA012", message: "Cuerpo de la solicitud inválido." }, 400);
  }

  if (!body.tramo_id) {
    return respuestaError({ code: "PA012", message: "tramo_id es obligatorio." }, 400);
  }
  const tramoId = body.tramo_id;

  // T010: defensa en profundidad — iniciar_liquidacion_tramo ya está restringida a service_role,
  // pero validamos el rol aquí también antes de tocar nada (mismo patrón que asignar-factura).
  const { data: perfil, error: perfilError } = await supabaseService
    .from("perfiles")
    .select("rol")
    .eq("id", operadorId)
    .single();

  if (perfilError || !perfil || perfil.rol !== "operador_banco") {
    return respuestaError(
      { code: "PA008", message: "Solo el operador de banco puede liquidar un tramo." },
      403,
    );
  }

  // T011: valida (rol de negocio, facturas cobradas, estado del tramo) y arranca la liquidación.
  // Si falla, responde de inmediato sin tocar Stellar.
  const { data: inicio, error: inicioError } = await supabaseService.rpc(
    "iniciar_liquidacion_tramo",
    { p_tramo_id: tramoId },
  );

  if (inicioError) {
    return respuestaError(errorDesdeSupabase(inicioError), 400);
  }

  const inversionistas = (inicio.inversionistas ?? []) as InversionistaPendiente[];

  // T012: datos del tramo/pool necesarios para calcular el pago de cada inversionista.
  const { data: tramo } = await supabaseService
    .from("tramos")
    .select("pool_id, token_contract_id, rendimiento_ilustrativo_plazo_pct")
    .eq("id", tramoId)
    .single();

  if (!tramo?.token_contract_id) {
    return respuestaError(
      { code: "PA019", message: "El tramo no tiene un contrato asociado — no se puede liquidar." },
      400,
    );
  }

  const [{ data: pool }, { data: secretoCustodia, error: secretoCustodiaError }] = await Promise.all([
    supabaseService
      .from("pools")
      .select("unidad_minima_aporte, custody_public_key, moneda")
      .eq("id", tramo.pool_id)
      .single(),
    supabaseService.rpc("obtener_secreto_custodia_pool", { p_pool_id: tramo.pool_id }),
  ]);

  if (!pool?.custody_public_key || secretoCustodiaError || !secretoCustodia) {
    return respuestaError(
      { code: "PA019", message: "No se pudo obtener la wallet de custodia del pool." },
      500,
    );
  }

  // El monto se calcula en la moneda del pool (soles/dólares) pero el pago es siempre en XLM —
  // misma tasa de referencia que usa cotizar_aporte (0006_tipo_cambio.sql, tasa_moneda_por_xlm =
  // unidades de la moneda por 1 XLM).
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

  const resultados: ResultadoInversionista[] = [];

  // T013-T019: cada inversionista se procesa de forma independiente — un fallo puntual no
  // detiene a los siguientes (FR-008, research.md §3).
  for (const inv of inversionistas) {
    let fracciones: number;
    try {
      fracciones = Number(
        await consultarSoloLectura(tramo.token_contract_id, "balance", [
          { type: "address", value: inv.wallet_public_key },
        ]),
      );
    } catch {
      // No se pudo ni siquiera leer el balance — no hay nada que pagar ni que revertir todavía.
      await registrarCompensado(resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, "fallo_lectura_balance");
      continue;
    }

    // T014: sin fracciones reales on-chain, nada que pagar (FR-004) — se deja evidencia igual.
    if (fracciones === 0) {
      await registrarPagado(resultados, tramoId, inv.investor_id, 0, 0, pool.moneda, null, null);
      continue;
    }

    const monto = fracciones * pool.unidad_minima_aporte *
      (1 + tramo.rendimiento_ilustrativo_plazo_pct / 100);
    const montoXlm = monto / tasaMonedaPorXlm;

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

    // T015: pago real, custodia -> inversionista.
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

    // T016: quema real, firmada con la llave del propio inversionista (from.require_auth()).
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
      // T017
      await registrarPagado(resultados, tramoId, inv.investor_id, fracciones, monto, pool.moneda, txPago, txQuema);
    } catch (err) {
      // T018: la quema falló tras reintentos, pero el pago ya se ejecutó — revertirlo
      // (inversionista -> custodia, dirección inversa).
      console.error("Fallo al quemar fracciones al liquidar, revirtiendo el pago", {
        tramoId,
        investorId: inv.investor_id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await pagarXlm(supabaseService, secretoInversionista, pool.custody_public_key, montoXlm);
      } catch {
        // El propio reembolso también falló — se deja evidencia igual (motivo distinto), requiere
        // reconciliación manual (mismo límite conocido que compensarYResponder en confirmar-aporte).
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

  // T020: todos los inversionistas de la lista quedaron pagados o compensados — cerrar el tramo.
  await supabaseService.rpc("finalizar_liquidacion_tramo", { p_tramo_id: tramoId });

  return new Response(
    JSON.stringify({ ok: true, tramo_id: tramoId, estado_liquidacion: "liquidado", resultados }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});
