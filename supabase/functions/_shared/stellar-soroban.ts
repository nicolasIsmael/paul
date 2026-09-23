// Feature: Originación de Facturas y Tokenización de Fracciones de Pool
// (specs/20260920-174938-originacion-facturas-pool)
// T037: invocar el contrato Soroban de un tramo desde una Edge Function Deno, y consultas de
// solo lectura sin firma ni fee. Mismo estilo que _shared/stellar-payment.ts (spec previa):
// timeout interno acotado, nunca deja la Edge Function que lo invoca colgada por más de unos
// segundos por intento (research.md §4).
//
// Verificado en vivo contra testnet (T050): `register_invoice` y `mint` invocados con éxito sobre
// contratos reales. Dos bugs reales encontrados y corregidos durante esa verificación:
// 1) Deno no expone el global `Buffer` de Node — `argToScVal("bytes32", ...)` usaba
//    `Buffer.from(hex, "hex")` y fallaba en runtime con "Buffer is not defined"; reemplazado por
//    `hexToBytes` (abajo).
// 2) `@stellar/stellar-sdk@^13` NO PUEDE parsear `getTransaction()` contra una red en protocolo
//    28 (la meta de transacción usa una variante de unión XDR que esa versión del SDK no conoce:
//    "Bad union switch: 4" en `@stellar/js-xdr`). Esto hacía que TODA llamada exitosa a
//    `register_invoice`/`mint` lanzara una excepción justo después de confirmarse on-chain,
//    disparando reintentos que sometían la MISMA operación varias veces más (inofensivo para
//    `register_invoice`, que el propio contrato deduplica por huella — pero produjo emisiones
//    duplicadas reales con `mint`, que no tiene esa protección). Corregido subiendo a
//    `@stellar/stellar-sdk@^17`, que sí interpreta correctamente el protocolo actual — verificado
//    contra la transacción real de este mismo hallazgo antes de desplegar la corrección.
//
// Verificado en vivo contra testnet (validación de quickstart.md §8, concurrencia): un tercer bug
// real, más serio. Dos invocaciones concurrentes de `invocarContratoAdmin` firman con la MISMA
// cuenta `operador_authority` (compartida por toda la plataforma) — Stellar solo admite una
// transacción "en vuelo" por número de secuencia de cuenta, así que la segunda choca y falla.
// Reproducido con 3 aportes confirmándose en paralelo sobre el mismo tramo: las 3 invocaciones de
// `mint` chocaron entre sí, y el mismo problema alcanzó a la compensación (dos reembolsos del
// mismo pool firman con su misma cuenta de custodia) — un aporte quedó con el pago XLM ya hecho
// pero sin fracciones ni reembolso hasta reconciliarlo a mano. Corregido con un lock de
// aplicación por cuenta firmante respaldado en Postgres (`_shared/lock-firma.ts`,
// 0016_lock_firma_stellar.sql) que serializa el tramo cargar-secuencia -> firmar -> someter de
// cualquier cuenta Stellar compartida entre invocaciones concurrentes — necesario porque las Edge
// Functions no comparten memoria entre sí (un mutex en proceso no sirve). Verificado repitiendo
// la misma ráfaga de 6 aportes concurrentes tras la corrección: las 3 reservas válidas mintean
// sin colisión, y las 3 rechazadas por cupo fallan limpiamente sin tocar la red Stellar.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "npm:@stellar/stellar-sdk@^17";
import { conLockFirma } from "./lock-firma.ts";

const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = 2_000;
// Timeout para cada paso previo a la confirmación (getAccount/prepareTransaction/sendTransaction
// — normalmente responden en 1-3s).
const POLL_TIMEOUT_MS = 15_000;
// Timeout SOLO para el polling de confirmación de la transacción ya enviada. Verificado en vivo
// (T050): 15s resultó insuficiente bajo latencia real de testnet — una transacción confirmó
// exitosamente on-chain después de ese punto, pero el cliente ya la había dado por perdida y
// reintentó, chocando con la propia guarda de duplicados del contrato (InvoiceAlreadyRegistered).
// 45s da margen suficiente sin dejar la Edge Function colgada indefinidamente.
const CONFIRMATION_TIMEOUT_MS = 45_000;

const server = new rpc.Server(SOROBAN_RPC_URL);

function conTimeout<T>(promise: Promise<T>, mensaje: string, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(mensaje)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/** Convierte argumentos JS simples (string, número, BytesN en hex, Address) a ScVal. */
type ArgSpec =
  | { type: "address"; value: string }
  | { type: "i128"; value: number | bigint }
  | { type: "bytes32"; value: string } // hex de 64 caracteres
  | { type: "string"; value: string }
  | { type: "symbol"; value: string };

/** Deno no expone `Buffer` (global de Node) — se decodifica el hex a mano. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function argToScVal(arg: ArgSpec) {
  switch (arg.type) {
    case "address":
      return new Address(arg.value).toScVal();
    case "i128":
      return nativeToScVal(arg.value, { type: "i128" });
    case "bytes32":
      return nativeToScVal(hexToBytes(arg.value), { type: "bytes" });
    case "string":
      return nativeToScVal(arg.value, { type: "string" });
    case "symbol":
      return nativeToScVal(arg.value, { type: "symbol" });
  }
}

/**
 * Invoca una función administrativa del contrato de un tramo, firmando con la llave de la
 * autoridad de plataforma. Simula primero (`prepareTransaction`) — si el contrato rechaza la
 * llamada (p. ej. `CapExceeded`), lanza de inmediato sin someter nada a la red, evitando pagar un
 * fee por una transacción que ya se sabe que va a fallar (research.md §4).
 *
 * Lanza un Error si falla; el llamador decide reintentar (hasta 3 intentos totales, research.md
 * §2) o compensar.
 */
export async function invocarContratoAdmin(
  supabase: SupabaseClient,
  secretoAdmin: string,
  contractId: string,
  metodo: string,
  args: ArgSpec[],
): Promise<{ hash: string; valorRetorno: unknown }> {
  const keypair = Keypair.fromSecret(secretoAdmin);

  // `operador_authority` es UNA sola cuenta compartida por toda la plataforma para firmar
  // register_invoice/mint — dos invocaciones concurrentes (p. ej. dos aportes confirmándose a la
  // vez) chocan por número de secuencia si no se serializan (quickstart.md §8, 0016).
  return await conLockFirma(supabase, keypair.publicKey(), async () => {
    const cuenta = await conTimeout(
      server.getAccount(keypair.publicKey()),
      "timeout_soroban_get_account",
      POLL_TIMEOUT_MS,
    );

    const contrato = new Contract(contractId);
    const operacion = contrato.call(metodo, ...args.map(argToScVal));

    let transaccion = new TransactionBuilder(cuenta, {
      fee: "1000000", // fee máximo dispuesto a pagar; prepareTransaction lo ajusta al costo real.
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(operacion)
      .setTimeout(60)
      .build();

    transaccion = await conTimeout(
      server.prepareTransaction(transaccion) as unknown as Promise<typeof transaccion>,
      "timeout_soroban_prepare",
      POLL_TIMEOUT_MS,
    );

    transaccion.sign(keypair);

    const envio = await conTimeout(
      server.sendTransaction(transaccion),
      "timeout_soroban_send",
      POLL_TIMEOUT_MS,
    );

    if (envio.status === "ERROR") {
      throw new Error(`soroban_send_error: ${JSON.stringify(envio.errorResult)}`);
    }

    const hash = envio.hash;
    const inicio = Date.now();
    while (Date.now() - inicio < CONFIRMATION_TIMEOUT_MS) {
      const resultado = await server.getTransaction(hash);
      if (resultado.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const valorRetorno = resultado.returnValue ? scValToNative(resultado.returnValue) : null;
        return { hash, valorRetorno };
      }
      if (resultado.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`soroban_tx_failed: ${JSON.stringify(resultado.resultXdr)}`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    throw new Error("timeout_soroban_confirmacion");
  });
}

/**
 * Invoca `invocarContratoAdmin` con hasta `intentos` intentos y backoff corto (1s, 2s, ...) —
 * cubre el caso común de un timeout transitorio de Soroban RPC (research.md §2).
 */
export async function invocarContratoAdminConReintentos(
  supabase: SupabaseClient,
  secretoAdmin: string,
  contractId: string,
  metodo: string,
  args: ArgSpec[],
  intentos = 3,
): Promise<{ hash: string; valorRetorno: unknown }> {
  let ultimoError: unknown;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      return await invocarContratoAdmin(supabase, secretoAdmin, contractId, metodo, args);
    } catch (err) {
      ultimoError = err;
      if (intento < intentos) {
        await new Promise((r) => setTimeout(r, intento * 1000));
      }
    }
  }
  throw ultimoError instanceof Error ? ultimoError : new Error(String(ultimoError));
}

/**
 * Lectura de solo lectura (`balance`, `cap`, `total_supply`, ...) vía simulación — sin firma ni
 * fee, nunca se somete nada a la red. Usa la propia cuenta del contrato como origen simulado
 * (cualquier cuenta válida sirve para una simulación de solo lectura).
 */
export async function consultarSoloLectura(
  contractId: string,
  metodo: string,
  args: ArgSpec[] = [],
): Promise<unknown> {
  // Cuenta de origen "fantasma": una simulación de solo lectura no exige que exista de verdad ni
  // que pague fee — solo se usa para construir una transacción sintáctica válida.
  const cuentaFantasma = Keypair.random();
  const cuenta = await server.getAccount(cuentaFantasma.publicKey()).catch(
    () => new Account(cuentaFantasma.publicKey(), "0"),
  );

  const contrato = new Contract(contractId);
  const transaccion = new TransactionBuilder(cuenta as never, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contrato.call(metodo, ...args.map(argToScVal)))
    .setTimeout(30)
    .build();

  const simulacion = await conTimeout(
    server.simulateTransaction(transaccion),
    "timeout_soroban_simulate",
    POLL_TIMEOUT_MS,
  );

  if (rpc.Api.isSimulationError(simulacion)) {
    throw new Error(`soroban_simulacion_error: ${simulacion.error}`);
  }

  return simulacion.result?.retval ? scValToNative(simulacion.result.retval) : null;
}
