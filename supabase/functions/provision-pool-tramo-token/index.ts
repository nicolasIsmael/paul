// Feature: Originación de Facturas y Tokenización de Fracciones de Pool
// (specs/20260920-174938-originacion-facturas-pool)
// T038: instancia una nueva copia del contrato ya subido a testnet (mismo wasm_hash, distinta
// dirección) para un tramo recién creado, e invoca `initialize`. Invocada EXCLUSIVAMENTE por un
// Database Webhook (insert on tramos) — mismo patrón que provision-investor-wallet/
// provision-pool-custody (spec previa). verify_jwt=false + secreto compartido. Contrato completo:
// contracts/provision-pool-tramo-token-function.md.
//
// NOTA: no se ha ejercitado en vivo (solo se dispara al insertar un tramo nuevo, y los 12 tramos
// existentes ya tienen contrato desde el despliegue inicial de T035). Comparte
// `_shared/stellar-soroban.ts` — mismo `@stellar/stellar-sdk@^17` verificado ahí (T050).
// `Operation.createCustomContract` sigue sin ejercitarse contra tráfico real; es la pieza de
// mayor incertidumbre restante de este archivo (quickstart.md §0).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash as stellarHash,
  rpc,
  xdr,
} from "npm:@stellar/stellar-sdk@^17";
import { hexToBytes, invocarContratoAdminConReintentos } from "../_shared/stellar-soroban.ts";

const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const server = new rpc.Server(SOROBAN_RPC_URL);

const supabaseService: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function respuesta(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Instancia una nueva copia del contrato ya subido (mismo wasm_hash) con una salt aleatoria. */
async function instanciarContrato(secretoAdmin: string, wasmHash: string): Promise<string> {
  const keypair = Keypair.fromSecret(secretoAdmin);
  const cuenta = await server.getAccount(keypair.publicKey());
  const salt = stellarHash(crypto.getRandomValues(new Uint8Array(32)));

  const operacion = Operation.createCustomContract({
    address: new Address(keypair.publicKey()),
    wasmHash: hexToBytes(wasmHash),
    salt,
  });

  let transaccion = new TransactionBuilder(cuenta, {
    fee: "1000000",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operacion)
    .setTimeout(60)
    .build();

  transaccion = await server.prepareTransaction(transaccion) as unknown as typeof transaccion;
  transaccion.sign(keypair);

  const envio = await server.sendTransaction(transaccion);
  if (envio.status === "ERROR") {
    throw new Error(`create_contract_error: ${JSON.stringify(envio.errorResult)}`);
  }

  const inicio = Date.now();
  while (Date.now() - inicio < 15_000) {
    const resultado = await server.getTransaction(envio.hash);
    if (resultado.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      // La dirección del contrato recién creado viene en el resultado de la operación.
      const contractId = xdr.ScAddress
        .fromXDR(resultado.resultMetaXdr!.v3().sorobanMeta()!.returnValue().address().toXDR())
        .contractId()
        .toString("hex");
      return contractId;
    }
    if (resultado.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(`create_contract_failed: ${JSON.stringify(resultado.resultXdr)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("timeout_create_contract");
}

async function autenticado(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-webhook-secret");
  if (!recibido) return false;

  // Misma función ya existente (0002_wallet_provisioning.sql) que usan provision-investor-wallet
  // y provision-pool-custody — no se inventa un mecanismo nuevo de validación.
  const { data: esperado, error } = await supabaseService.rpc("obtener_shared_secret_webhook");
  if (error || !esperado) return false;
  return recibido === esperado;
}

Deno.serve(async (req: Request) => {
  if (!(await autenticado(req))) {
    return respuesta({ ok: false, error: { code: "PA008", message: "Secreto de webhook inválido." } }, 401);
  }

  let body: { record?: { id?: string; token_contract_id?: string | null; pool_id?: string; tipo?: string } };
  try {
    body = await req.json();
  } catch {
    return respuesta({ ok: false, error: { code: "PA012", message: "Payload inválido." } }, 400);
  }

  const tramo = body.record;
  if (!tramo?.id || tramo.token_contract_id) {
    // Ya tiene contrato (no debería pasar en un INSERT, pero es defensivo e idempotente).
    return respuesta({ ok: true, skipped: true }, 200);
  }

  const [{ data: config }, { data: secretoAdmin }, { data: pool }] = await Promise.all([
    supabaseService.rpc("obtener_configuracion_red", { p_red: "testnet" }),
    supabaseService.rpc("obtener_secreto_autoridad_operador", { p_red: "testnet" }),
    supabaseService.from("pools").select("codigo").eq("id", tramo.pool_id!).single(),
  ]);

  if (!config?.[0] || !secretoAdmin || !pool) {
    return respuesta(
      { ok: false, error: { code: "PA019", message: "Configuración de red no disponible." } },
      500,
    );
  }

  try {
    const contractId = await instanciarContrato(secretoAdmin, config[0].token_wasm_hash);

    await invocarContratoAdminConReintentos(secretoAdmin, contractId, "initialize", [
      { type: "address", value: config[0].operador_authority_public_key },
      { type: "string", value: pool.codigo },
      { type: "symbol", value: tramo.tipo! },
    ]);

    await supabaseService.from("tramos").update({ token_contract_id: contractId }).eq("id", tramo.id);

    return respuesta({ ok: true, token_contract_id: contractId }, 200);
  } catch (err) {
    return respuesta(
      { ok: false, error: { code: "PA019", message: err instanceof Error ? err.message : String(err) } },
      500,
    );
  }
});
