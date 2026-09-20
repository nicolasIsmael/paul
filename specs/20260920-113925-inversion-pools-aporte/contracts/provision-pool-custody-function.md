# Contrato: Edge Function `provision-pool-custody`

Análoga a `provision-investor-wallet` (feature previa) — invocada exclusivamente por un Database
Webhook sobre `public.pools` (`INSERT`, filtrado a `custody_secret_id IS NULL`), nunca por un
cliente. Ver `research.md` §4 (por qué una cuenta dedicada por pool) y `data-model.md` §Pool.
Reutiliza el mismo helper compartido `_shared/stellar-keypair.ts` que ya usa
`provision-investor-wallet` (generar keypair + fondear con Friendbot + guardar en Vault) — sin
duplicar esa lógica.

## Entrada (payload del Database Webhook)

```ts
type WebhookPayload = {
  type: "INSERT";
  table: "pools";
  schema: "public";
  record: {
    id: string;               // uuid del pool
    custody_secret_id: null;  // siempre null en este punto
  };
  old_record: null;
};
```

Autenticación idéntica a `provision-investor-wallet`: header `x-webhook-secret` comparado contra
el mismo secreto compartido de Vault (`webhook_shared_secret`) vía
`obtener_shared_secret_webhook()`.

## Procesamiento

1. `Keypair.random()` → nuevo par de llaves, exclusivo de este pool.
2. Fondear en testnet vía Friendbot.
3. `vault.create_secret(secretKey, 'stellar_pool_custody_' || pool_id)` → `custody_secret_id`.
4. `UPDATE public.pools SET custody_public_key = ..., custody_secret_id = ... WHERE id =
   record.id AND custody_secret_id IS NULL` (vía la función interna
   `aprovisionar_custodia_pool(pool_id, custody_public_key, custody_secret)`, `service_role`,
   idempotente igual que `aprovisionar_wallet_inversionista`).

## Salida

- **Éxito**: `200`, `{ ok: true, custody_public_key }`.
- **Fallo de Friendbot**: `500`, `{ ok: false, error }`; `pools.custody_public_key`/
  `custody_secret_id` quedan en `NULL` — reintentable re-emitiendo el `INSERT` original no aplica
  (el pool ya existe), así que el reintento es manual: volver a invocar esta función con el mismo
  `record.id`, igual que documenta `provision-investor-wallet-function.md` para wallets.

## Efecto sobre el resto del sistema mientras `custody_public_key` es `NULL`

Un pool cuya custodia todavía no terminó de aprovisionarse puede seguir apareciendo en
`catalogo_pools`/`detalle_pool` con normalidad (son datos agregados de `tramos`/`operaciones`, no
dependen de la custodia) — pero `cotizar_aporte` lo trata igual que un pool sin tipo de cambio
disponible sería tratado si le faltara algo crítico: en la práctica, para esta feature, todos los
pools de la carga de datos de ejemplo deben terminar su aprovisionamiento de custodia antes de la
demo (ver `quickstart.md`), igual que ya se exige para las wallets de las 3 cuentas demo de
inversionista.

## Fuera de este contrato

- No firma pagos **desde** la cuenta de custodia — en esta feature el dinero solo entra a la
  custodia (inversionista → pool), nunca sale. Firmar transacciones desde la custodia (reparto de
  retornos) pertenece a una feature posterior.
