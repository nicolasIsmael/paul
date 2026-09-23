import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { generarYFondearKeypair } from "../_shared/stellar-keypair.ts";
import { conLockFirma } from "../_shared/lock-firma.ts";
import {
  enviarTransaccionXdr,
  existeTransaccion,
  obtenerBalanceXlm,
  prepararPagoXlm,
} from "../_shared/stellar-payment.ts";

const RESERVA_MINIMA_XLM = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ErrorApi = { code: string; message: string; [extra: string]: unknown };

type ReservaRecarga = {
  recarga_id: string;
  wallet_public_key: string;
  moneda: "PEN" | "USD";
  monto: number;
  monto_xlm: number;
  tx_hash?: string | null;
  tx_xdr?: string | null;
  estado: "reservada" | "confirmada" | "revertida";
  ya_existia: boolean;
};

type Tesoreria = { public_key: string; secret_key: string };

const supabaseService: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function respuestaError(error: ErrorApi, status: number): Response {
  return json({ ok: false, error }, status);
}

function errorDesdeSupabase(err: { code?: string; message: string; details?: string | null }): ErrorApi {
  let extra: Record<string, unknown> = {};
  if (err.details) {
    try {
      extra = JSON.parse(err.details);
    } catch {
      // El mensaje principal ya contiene el detalle legible.
    }
  }
  return { code: err.code ?? "PA013", message: err.message, ...extra };
}

async function obtenerOAprovisionarTesoreria(): Promise<Tesoreria> {
  const { data: existente, error: lecturaError } = await supabaseService.rpc(
    "obtener_tesoreria_demo",
  );
  if (lecturaError) throw lecturaError;
  if (existente?.public_key && existente?.secret_key) return existente as Tesoreria;

  const nueva = await generarYFondearKeypair();
  const { data, error } = await supabaseService.rpc("aprovisionar_tesoreria_demo", {
    p_public_key: nueva.publicKey,
    p_secret_key: nueva.secretKey,
  });
  if (error || !data?.public_key || !data?.secret_key) {
    throw error ?? new Error("No se pudo aprovisionar la tesorería de Testnet.");
  }
  return data as Tesoreria;
}

async function revertir(recargaId: string, motivo: string): Promise<void> {
  await supabaseService.rpc("revertir_recarga_wallet", {
    p_recarga_id: recargaId,
    p_motivo: motivo.slice(0, 500),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return respuestaError({ code: "PA012", message: "Método no permitido." }, 405);
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

  let body: { moneda?: string; monto?: number; idempotency_key?: string };
  try {
    body = await req.json();
  } catch {
    return respuestaError({ code: "PA012", message: "Cuerpo de la solicitud inválido." }, 400);
  }

  const monto = Number(body.monto);
  if (
    !["PEN", "USD"].includes(body.moneda ?? "")
    || !Number.isFinite(monto)
    || monto <= 0
    || !body.idempotency_key
    || !UUID_PATTERN.test(body.idempotency_key)
  ) {
    return respuestaError(
      { code: "PA001", message: "Moneda, monto positivo y clave de idempotencia válida son obligatorios." },
      400,
    );
  }

  const { data: reservaData, error: reservaError } = await supabaseService.rpc(
    "reservar_recarga_wallet",
    {
      p_investor_id: userData.user.id,
      p_moneda: body.moneda,
      p_monto: monto,
      p_idempotency_key: body.idempotency_key,
    },
  );
  if (reservaError) return respuestaError(errorDesdeSupabase(reservaError), 400);

  const reserva = reservaData as ReservaRecarga;
  if (reserva.estado === "revertida") {
    return respuestaError(
      { code: "PA013", message: "Esta recarga fue revertida. Intenta nuevamente." },
      409,
    );
  }

  if (reserva.estado === "confirmada") {
    const { data, error } = await supabaseService.rpc("confirmar_recarga_wallet", {
      p_recarga_id: reserva.recarga_id,
    });
    if (error) return respuestaError(errorDesdeSupabase(error), 500);
    const balanceXlm = await obtenerBalanceXlm(reserva.wallet_public_key).catch(() => null);
    return json({
      ok: true,
      ...data,
      wallet_public_key: reserva.wallet_public_key,
      balance_xlm: balanceXlm,
      red: "stellar-testnet",
    });
  }

  let tesoreria: Tesoreria;
  try {
    tesoreria = await obtenerOAprovisionarTesoreria();
    const balanceTesoreria = await obtenerBalanceXlm(tesoreria.public_key);
    if (balanceTesoreria - Number(reserva.monto_xlm) < RESERVA_MINIMA_XLM) {
      await revertir(reserva.recarga_id, "tesoreria_sin_xlm");
      return respuestaError(
        { code: "PA013", message: "La tesorería de Testnet no tiene XLM suficiente para esta recarga." },
        503,
      );
    }
  } catch (error) {
    await revertir(reserva.recarga_id, "fallo_tesoreria");
    return respuestaError(
      { code: "PA013", message: error instanceof Error ? error.message : "No se pudo preparar la tesorería." },
      502,
    );
  }

  let txHash = reserva.tx_hash ?? null;
  let txXdr = reserva.tx_xdr ?? null;
  try {
    const enviarPago = async () => {
      if (!txHash || !txXdr) {
        const preparada = await prepararPagoXlm(
          tesoreria.secret_key,
          reserva.wallet_public_key,
          Number(reserva.monto_xlm),
        );
        const { data: registrada, error } = await supabaseService.rpc(
          "registrar_transaccion_recarga",
          {
            p_recarga_id: reserva.recarga_id,
            p_tx_hash: preparada.hash,
            p_tx_xdr: preparada.xdr,
          },
        );
        if (error) throw error;
        txHash = registrada.tx_hash;
        txXdr = registrada.tx_xdr;
      }

      try {
        await enviarTransaccionXdr(txXdr!);
      } catch (submitError) {
        if (!txHash || !(await existeTransaccion(txHash))) throw submitError;
      }
    };

    if (reserva.tx_xdr) await enviarPago();
    else await conLockFirma(supabaseService, tesoreria.public_key, enviarPago);
  } catch (error) {
    await revertir(reserva.recarga_id, "fallo_red_stellar");
    return respuestaError(
      { code: "PA013", message: error instanceof Error ? error.message : "Stellar rechazó la recarga." },
      502,
    );
  }

  const { data: confirmada, error: confirmacionError } = await supabaseService.rpc(
    "confirmar_recarga_wallet",
    { p_recarga_id: reserva.recarga_id },
  );
  if (confirmacionError) {
    // La operación ya puede existir en Stellar. Conservar la reserva permite reconciliar el mismo
    // hash en un reintento, sin enviar un segundo pago.
    return respuestaError(
      { ...errorDesdeSupabase(confirmacionError), tx_hash: txHash },
      500,
    );
  }

  const balanceXlm = await obtenerBalanceXlm(reserva.wallet_public_key).catch(() => null);
  return json({
    ok: true,
    ...confirmada,
    wallet_public_key: reserva.wallet_public_key,
    balance_xlm: balanceXlm,
    red: "stellar-testnet",
  });
});
