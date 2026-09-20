// Feature: Exploración de Pools y Primer Aporte del Inversionista
// (specs/20260920-113925-inversion-pools-aporte)
// T027: invocada exclusivamente por el trigger `pools_provision_custody` (ver
// supabase/migrations/0005_custodia_pools.sql) — nunca por un cliente. Contrato completo en
// contracts/provision-pool-custody-function.md. Mismo patrón de autenticación que
// provision-investor-wallet (secreto compartido de Vault, verify_jwt=false) y misma lógica de
// generar+fondear un keypair, reutilizada desde _shared/stellar-keypair.ts (T023) en vez de
// duplicarla.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { generarYFondearKeypair } from "../_shared/stellar-keypair.ts";

type WebhookPayload = {
  type: "INSERT";
  table: string;
  schema: string;
  record: {
    id: string;
    custody_secret_id: string | null;
  };
  old_record: Record<string, unknown> | null;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function autenticado(req: Request): Promise<boolean> {
  const recibido = req.headers.get("x-webhook-secret");
  if (!recibido) return false;

  const { data: esperado, error } = await supabase.rpc("obtener_shared_secret_webhook");

  if (error || !esperado) return false;
  return recibido === esperado;
}

Deno.serve(async (req: Request) => {
  if (!(await autenticado(req))) {
    return new Response(JSON.stringify({ ok: false, error: "no_autorizado" }), { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "payload_invalido" }), { status: 400 });
  }

  const { record } = payload;

  // Defensa en profundidad: aunque el trigger de origen ya filtra por custody_secret_id IS NULL,
  // se revalida aquí antes de generar nada.
  if (record.custody_secret_id) {
    return new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 });
  }

  let publicKey: string;
  let secretKey: string;
  try {
    ({ publicKey, secretKey } = await generarYFondearKeypair());
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500 },
    );
  }

  const { error } = await supabase.rpc("aprovisionar_custodia_pool", {
    pool_id: record.id,
    custody_public_key: publicKey,
    custody_secret: secretKey,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, custody_public_key: publicKey }),
    { status: 200 },
  );
});
