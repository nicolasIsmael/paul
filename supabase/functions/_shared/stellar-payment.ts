// Feature: Exploración de Pools y Primer Aporte del Inversionista
// (specs/20260920-113925-inversion-pools-aporte)
// T034: consultar balance XLM y someter un pago (Payment nativo) en Stellar testnet, con un
// timeout interno de 25s (research.md §3 — muy por debajo del límite de plataforma de 150s de
// las Edge Functions, para que confirmar-aporte siempre responda en la misma solicitud, FR-034).
//
// EXTENSIÓN (specs/20260920-174938-originacion-facturas-pool): `pagarXlm` ahora exige un cliente
// Supabase y sostiene `_shared/lock-firma.ts` mientras carga la secuencia de la cuenta y somete
// el pago — dos invocaciones concurrentes que firman con la MISMA cuenta (p. ej. dos reembolsos
// de compensación desde la custodia de un mismo pool) chocan por número de secuencia si no se
// serializan (hallazgo real de quickstart.md §8, ver 0016_lock_firma_stellar.sql).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "npm:@stellar/stellar-sdk@^17";
import { conLockFirma } from "./lock-firma.ts";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const TIMEOUT_MS = 25_000;

const server = new Horizon.Server(HORIZON_URL);

function conTimeout<T>(promise: Promise<T>, mensaje: string): Promise<T> {
  let timeoutId: number;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(mensaje)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/** Balance de XLM (nativo) de una cuenta de testnet, en unidades de XLM (no stroops). */
export async function obtenerBalanceXlm(publicKey: string): Promise<number> {
  const cuenta = await conTimeout(server.loadAccount(publicKey), "timeout_horizon_balance");
  const balance = cuenta.balances.find((b) => b.asset_type === "native");
  return balance ? parseFloat(balance.balance) : 0;
}

/**
 * Somete un pago en XLM nativo desde `secretOrigen` hacia `destinoPublicKey` por `montoXlm`.
 * Lanza un Error si Horizon rechaza la transacción o si supera el timeout interno de 25s — el
 * llamador (confirmar-aporte/index.ts) decide revertir la reserva en ese caso (PA013).
 */
export async function pagarXlm(
  supabase: SupabaseClient,
  secretOrigen: string,
  destinoPublicKey: string,
  montoXlm: number,
): Promise<{ hash: string }> {
  const keypairOrigen = Keypair.fromSecret(secretOrigen);

  return await conLockFirma(supabase, keypairOrigen.publicKey(), async () => {
    const cuentaOrigen = await conTimeout(
      server.loadAccount(keypairOrigen.publicKey()),
      "timeout_horizon_load_account",
    );

    const transaccion = new TransactionBuilder(cuentaOrigen, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destinoPublicKey,
          asset: Asset.native(),
          amount: montoXlm.toFixed(7),
        }),
      )
      .setTimeout(60)
      .build();

    transaccion.sign(keypairOrigen);

    const resultado = await conTimeout(
      server.submitTransaction(transaccion),
      "timeout_horizon_submit",
    );

    return { hash: resultado.hash };
  });
}
