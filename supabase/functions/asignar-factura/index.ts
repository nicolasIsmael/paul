// Feature: Originación de Facturas y Tokenización de Fracciones de Pool
// (specs/20260920-174938-originacion-facturas-pool)
// T039: orquesta reservar (Postgres) -> register_invoice (Soroban) -> confirmar/revertir, nunca
// deja la asignación pendiente de cara al cliente. Invocada directamente por el cliente
// autenticado (operador de banco), verify_jwt=true. Contrato completo:
// contracts/asignar-factura-function.md.
//
// Verificado en vivo contra testnet (T050): asigna una factura de ejemplo a un tramo real con
// `token_contract_id` desplegado y `register_invoice` confirmado on-chain.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { invocarContratoAdminConReintentos } from "../_shared/stellar-soroban.ts";

type ErrorApi = { code: string; message: string; [extra: string]: unknown };

const supabaseService: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function respuestaError(error: ErrorApi, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorDesdeSupabase(err: { code?: string; message: string }): ErrorApi {
  return { code: err.code ?? "PA019", message: err.message };
}

Deno.serve(async (req: Request) => {
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

  let body: { factura_id?: string; tramo_id?: string; anticipo?: number };
  try {
    body = await req.json();
  } catch {
    return respuestaError({ code: "PA012", message: "Cuerpo de la solicitud inválido." }, 400);
  }

  if (!body.factura_id || !body.tramo_id || typeof body.anticipo !== "number") {
    return respuestaError(
      { code: "PA012", message: "factura_id, tramo_id y anticipo son obligatorios." },
      400,
    );
  }

  // Defensa en profundidad — asignar_factura_a_pool ya está restringida a service_role, pero
  // validamos el rol aquí también antes de tocar Stellar (mismo patrón que confirmar-aporte).
  const { data: perfil, error: perfilError } = await supabaseService
    .from("perfiles")
    .select("rol")
    .eq("id", operadorId)
    .single();

  if (perfilError || !perfil || perfil.rol !== "operador_banco") {
    return respuestaError(
      { code: "PA008", message: "Solo el operador de banco puede asignar facturas." },
      403,
    );
  }

  // Paso 1: reservar (Postgres) — idempotente por factura_id.
  const { data: reserva, error: reservaError } = await supabaseService.rpc("asignar_factura_a_pool", {
    p_factura_id: body.factura_id,
    p_tramo_id: body.tramo_id,
    p_anticipo: body.anticipo,
  });

  if (reservaError) {
    return respuestaError(errorDesdeSupabase(reservaError), 400);
  }

  if (reserva.ya_existia && reserva.estado_asignacion === "asignada") {
    // Ya se confirmó antes (reintento) — nada más que hacer.
    return new Response(JSON.stringify({ ok: true, factura: reserva }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const facturaId: string = reserva.factura_id;
  const huellaHash: string = reserva.huella_hash;
  const fraccionesTotales: number = reserva.fracciones_totales;

  // Paso 2: leer configuración de red + contrato del tramo destino.
  const [{ data: config }, { data: secretoAdmin, error: secretoError }, { data: tramo }] =
    await Promise.all([
      supabaseService.rpc("obtener_configuracion_red", { p_red: "testnet" }),
      supabaseService.rpc("obtener_secreto_autoridad_operador", { p_red: "testnet" }),
      supabaseService.from("tramos").select("token_contract_id").eq("id", body.tramo_id).single(),
    ]);

  if (secretoError || !secretoAdmin || !config?.[0] || !tramo?.token_contract_id) {
    await supabaseService.rpc("revertir_asignacion_factura", { p_factura_id: facturaId });
    return respuestaError(
      { code: "PA019", message: "El tramo todavía no tiene su contrato listo, o la configuración de red no está disponible." },
      400,
    );
  }

  // Paso 3: register_invoice en el contrato, con reintentos acotados (research.md §2).
  try {
    const { hash } = await invocarContratoAdminConReintentos(
      supabaseService,
      secretoAdmin,
      tramo.token_contract_id,
      "register_invoice",
      [
        { type: "bytes32", value: huellaHash },
        { type: "i128", value: fraccionesTotales },
      ],
    );

    await supabaseService.rpc("confirmar_asignacion_factura", {
      p_factura_id: facturaId,
      p_onchain_tx_hash: hash,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        factura: { id: facturaId, estado_asignacion: "asignada", huella_hash: huellaHash },
        tramo_actualizado: {
          fracciones_totales: fraccionesTotales,
          reserva: reserva.reserva,
        },
        comprobante_onchain: { tx_hash: hash, red: "stellar-testnet", contrato: tramo.token_contract_id },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    await supabaseService.rpc("revertir_asignacion_factura", { p_factura_id: facturaId });
    return respuestaError(
      { code: "PA019", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});
