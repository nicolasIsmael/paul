// Feature: Registro, Inicio de Sesión y Perfil de Usuario (specs/20260919-131233-auth-perfil-usuario)
// T013-T015: invocada exclusivamente por el trigger `perfiles_provision_wallet` (ver
// supabase/migrations/0002_wallet_provisioning.sql) — nunca por un cliente. Contrato completo en
// specs/20260919-131233-auth-perfil-usuario/contracts/provision-investor-wallet-function.md.
//
// Desplegada con verify_jwt=false: el trigger que la invoca no tiene forma de obtener un JWT de
// Supabase (no se expone la service_role key a la automatización que aplicó esta migración), así
// que la autenticación es propia — un secreto compartido guardado en Supabase Vault
// ('webhook_shared_secret'), comparado en cada request contra el header x-webhook-secret que
// envía el trigger (ver comentario en 0002_wallet_provisioning.sql).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Keypair } from "npm:@stellar/stellar-sdk@^13";
import { createClient } from "npm:@supabase/supabase-js@2";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

type WebhookPayload = {
  type: "INSERT" | "UPDATE";
  table: string;
  schema: string;
  record: {
    id: string;
    rol: string | null;
    wallet_secret_id: string | null;
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

  // `vault` no es un esquema expuesto por PostgREST; se lee a través del wrapper
  // public.obtener_shared_secret_webhook() (ver supabase/migrations/0002_wallet_provisioning.sql).
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

  // Filtro de defensa en profundidad: aunque el trigger de origen ya filtra por
  // rol='inversionista' AND wallet_secret_id IS NULL, se revalida aquí antes de generar nada.
  if (record.rol !== "inversionista" || record.wallet_secret_id) {
    return new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 });
  }

  // T013: generar el keypair real de Stellar testnet.
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  // T014: fondear en testnet vía Friendbot. Si falla, no se continúa — el perfil queda con
  // wallet_public_key/wallet_secret_id en NULL, reintentable (ver Edge Case de la spec).
  const friendbotResponse = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!friendbotResponse.ok) {
    const detalle = await friendbotResponse.text();
    return new Response(
      JSON.stringify({ ok: false, error: `friendbot_fallo: ${detalle}` }),
      { status: 500 },
    );
  }

  // T015: guardar la llave privada en Vault y actualizar perfiles de forma atómica, usando
  // service_role (ignora RLS) vía la función aprovisionar_wallet_inversionista. Reutiliza el
  // mismo cliente `supabase` creado a nivel de módulo (línea 29).
  const { error } = await supabase.rpc("aprovisionar_wallet_inversionista", {
    perfil_id: record.id,
    wallet_public_key: publicKey,
    wallet_secret: secretKey,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true, wallet_public_key: publicKey }), { status: 200 });
});
