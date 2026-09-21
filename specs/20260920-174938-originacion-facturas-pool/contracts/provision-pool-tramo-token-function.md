# Contrato: Edge Function `provision-pool-tramo-token`

Invocada **exclusivamente por un Database Webhook** tras `insert on public.tramos` — el cliente
nunca la llama directamente, mismo patrón que `provision-investor-wallet`/`provision-pool-custody`
(spec previa). Desplegada con `verify_jwt = false` + secreto compartido (`webhook_shared_secret`,
ya existente, reutilizado sin cambios).

## Entrada (payload del webhook, formato ya estándar del proyecto)

```json
{ "type": "INSERT", "table": "tramos", "schema": "public", "record": { "id": "uuid", "pool_id": "uuid", "tipo": "senior", "...": "..." } }
```

## Procesamiento

1. Verifica `x-webhook-secret` (idéntico a los otros dos webhooks).
2. Si `record.token_contract_id` ya no es `null` (no debería pasar en un `INSERT`, pero
   defensivo), no hace nada — idempotente.
3. Lee `configuracion_red` (`token_wasm_hash`, `operador_authority_public_key`) y el secreto de la
   autoridad (`obtener_secreto_autoridad_operador()`).
4. Instancia una nueva copia del contrato ya subido a testnet: construye una operación
   `createContract` a partir del `token_wasm_hash` con una `salt` aleatoria, sometida y firmada por
   la autoridad de plataforma (`_shared/stellar-soroban.ts`) — esto es distinto de "subir" el WASM
   (eso ya ocurrió una sola vez, en el despliegue inicial, `contracts/deploy-contrato.md`); aquí
   solo se crea una instancia nueva que referencia ese mismo código ya publicado.
5. Invoca `initialize(admin, pool_ref, tramo)` sobre la instancia recién creada (`pool_ref` = 
   `pools.codigo` del pool de este tramo; `tramo` = `record.tipo`).
6. `update tramos set token_contract_id = <id de la instancia> where id = record.id`.

Sin reintentos internos más allá de los que ya provee la infraestructura de Database Webhooks de
Supabase (reintenta automáticamente si la función responde con error) — mismo comportamiento que
los dos webhooks ya existentes, sin necesidad de lógica adicional.

## Salida

`200` con `{ "ok": true, "token_contract_id": "C..." }`, o un código de error interno si la
instanciación falla (el webhook la reintenta automáticamente más tarde — un tramo sin `token_
contract_id` simplemente no puede recibir asignaciones de factura ni aportes todavía; `asignar-
factura`/`confirmar-aporte` deben tratar `token_contract_id is null` como `PA019` — "el tramo
todavía no tiene su contrato listo" — mismo espíritu que `PA007` para una wallet en creación).

## Fuera de este contrato

- No sube el WASM del contrato — eso ocurre una sola vez por todo el proyecto, en
  `contracts/deploy-contrato.md`, nunca por tramo.
- No se dispara para pools/tramos que ya tenían `token_contract_id` antes de esta feature (los
  sembrados por la spec previa) — esos se provisionan de forma retroactiva por el propio script de
  seed de esta feature (`quickstart.md` §7), no por este webhook (que solo escucha `INSERT`, y esas
  filas ya existen).
