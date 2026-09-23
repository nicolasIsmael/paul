// Pagos nativos de Stellar Testnet. Toda operación que construye una transacción nueva debe
// sostener el lock distribuido de la cuenta firmante para no reutilizar su sequence number.

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
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(mensaje)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export async function obtenerBalanceXlm(publicKey: string): Promise<number> {
  const cuenta = await conTimeout(server.loadAccount(publicKey), "timeout_horizon_balance");
  const balance = cuenta.balances.find((item) => item.asset_type === "native");
  return balance ? parseFloat(balance.balance) : 0;
}

export type PagoPreparado = { hash: string; xdr: string };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Construye y firma sin enviar. El llamador debe sostener `conLockFirma` hasta el submit. */
export async function prepararPagoXlm(
  secretOrigen: string,
  destinoPublicKey: string,
  montoXlm: number,
): Promise<PagoPreparado> {
  const keypairOrigen = Keypair.fromSecret(secretOrigen);
  const cuentaOrigen = await conTimeout(
    server.loadAccount(keypairOrigen.publicKey()),
    "timeout_horizon_load_account",
  );
  const transaccion = new TransactionBuilder(cuentaOrigen, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({
      destination: destinoPublicKey,
      asset: Asset.native(),
      amount: montoXlm.toFixed(7),
    }))
    .setTimeout(60)
    .build();

  transaccion.sign(keypairOrigen);
  return { hash: bytesToHex(transaccion.hash()), xdr: transaccion.toXDR() };
}

export async function enviarTransaccionXdr(xdr: string): Promise<{ hash: string }> {
  const transaccion = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  const resultado = await conTimeout(
    server.submitTransaction(transaccion),
    "timeout_horizon_submit",
  );
  return { hash: resultado.hash };
}

export async function existeTransaccion(hash: string): Promise<boolean> {
  try {
    await conTimeout(server.transactions().transaction(hash).call(), "timeout_horizon_transaction");
    return true;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "response" in error
      ? Number((error as { response?: { status?: number } }).response?.status)
      : 0;
    if (status === 404) return false;
    throw error;
  }
}

export async function pagarXlm(
  supabase: SupabaseClient,
  secretOrigen: string,
  destinoPublicKey: string,
  montoXlm: number,
): Promise<{ hash: string }> {
  const publicKeyOrigen = Keypair.fromSecret(secretOrigen).publicKey();
  return conLockFirma(supabase, publicKeyOrigen, async () => {
    const pago = await prepararPagoXlm(secretOrigen, destinoPublicKey, montoXlm);
    return enviarTransaccionXdr(pago.xdr);
  });
}
