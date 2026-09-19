# Contrato: Edge Function `provision-investor-wallet`

Invocada exclusivamente por el **Database Webhook** sobre `public.perfiles` (evento `INSERT`,
filtrado a `rol = 'inversionista' AND wallet_secret_id IS NULL`) — nunca invocada directamente
por ningún cliente. Con un único método de registro (email/contraseña, sin login social), el rol
siempre viene fijado desde el propio `INSERT`, así que no hace falta reaccionar a `UPDATE`. Ver
`research.md` §3-§4.

## Entrada (payload del Database Webhook)

```ts
type WebhookPayload = {
  type: "INSERT";
  table: "perfiles";
  schema: "public";
  record: {
    id: string; // uuid del perfil = auth.users.id
    rol: "inversionista";
    // ...resto de columnas de perfiles (wallet_public_key/wallet_secret_id en null en este punto)
  };
  old_record: null;
};
```

## Procesamiento

1. `Keypair.random()` (`@stellar/stellar-sdk`) → genera par de llaves.
2. Fondear en testnet vía Friendbot (`GET https://friendbot.stellar.org?addr={publicKey}`).
3. `vault.create_secret(secretKey)` (llamado como `service_role` vía RPC de Postgres) → devuelve
   `wallet_secret_id`.
4. `UPDATE public.perfiles SET wallet_public_key = ..., wallet_secret_id = ... WHERE id = record.id`
   (usando el cliente `service_role`, que ignora RLS).

## Salida

- **Éxito**: `200 OK`, cuerpo `{ ok: true, wallet_public_key }`.
- **Fallo de Friendbot (red transitoria)**: `500`, cuerpo `{ ok: false, error }`; el perfil queda
  con `wallet_public_key`/`wallet_secret_id` en `NULL` — reintentable manualmente (reinvocando la
  función con el mismo `record.id`) o automáticamente si se configura reintento en el Database
  Webhook. No debe dejar un secreto a medio guardar (la escritura en Vault y el `UPDATE` de
  `perfiles` ocurren solo si el fondeo fue exitoso).

## Fuera de este contrato

- No firma ni construye transacciones de negocio (compra de fracciones, pools) — eso pertenece a
  features futuras que reutilizarán el mismo `wallet_secret_id` para firmar, no a este endpoint.
- No se expone vía URL pública documentada a los clientes; su URL de invocación (la del Database
  Webhook) no forma parte de la superficie de API que un frontend consume.
