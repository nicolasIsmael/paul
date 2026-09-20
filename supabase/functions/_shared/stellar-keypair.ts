// Feature: Exploración de Pools y Primer Aporte del Inversionista
// (specs/20260920-113925-inversion-pools-aporte)
// T023: extraído de provision-investor-wallet/index.ts (feature previa) para reutilizar la misma
// lógica de generar+fondear un keypair de Stellar testnet en provision-pool-custody/index.ts,
// sin duplicarla (Principio I de la constitución — responsabilidad única, evitar repetir código).

import { Keypair } from "npm:@stellar/stellar-sdk@^13";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

export type KeypairFondeado = {
  publicKey: string;
  secretKey: string;
};

/**
 * Genera un keypair de Stellar testnet y lo funda vía Friendbot.
 *
 * Lanza un Error (mensaje `friendbot_fallo: <detalle>`) si el fondeo falla — el llamador decide
 * qué hacer (no continuar, dejar el registro pendiente de reintento). Friendbot solo funda una
 * cuenta la primera vez; un segundo intento sobre la misma cuenta ya fondeada es rechazado
 * (verificado en research.md §5 de esta feature) — por eso este helper siempre se usa con un
 * keypair recién generado, nunca para "recargar" uno existente.
 */
export async function generarYFondearKeypair(): Promise<KeypairFondeado> {
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();

  const friendbotResponse = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!friendbotResponse.ok) {
    const detalle = await friendbotResponse.text();
    throw new Error(`friendbot_fallo: ${detalle}`);
  }

  return { publicKey, secretKey };
}
