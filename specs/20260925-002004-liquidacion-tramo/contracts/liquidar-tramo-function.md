# Contrato: Edge Function `liquidar-tramo`

Invocada **directamente por el cliente autenticado** (operador de banco), mismo patrón que
`asignar-factura`/`confirmar-aporte`: la respuesta HTTP final llega en la misma solicitud, nunca
queda "pendiente". Desplegada con `verify_jwt = true`. Cubre las 3 historias de la spec (FR-001 –
FR-011).

## Entrada

```http
POST /functions/v1/liquidar-tramo
Authorization: Bearer <jwt del operador de banco>
Content-Type: application/json

{ "tramo_id": "uuid" }
```

Sin `idempotency_key` explícito — `tramo_id` ya es la clave natural (un tramo solo puede tener una
liquidación en curso a la vez, garantizado por `estado_liquidacion`); reintentar la solicitud
completa es seguro gracias a la idempotencia de `iniciar_liquidacion_tramo` (salta a
inversionistas ya procesados) y de `registrar_pago_liquidacion`/`registrar_liquidacion_compensada`
(`on conflict do nothing`).

## Procesamiento

1. Valida el JWT y `perfiles.rol = 'operador_banco'` (`service_role`, defensa en profundidad) →
   `403 PA008` si no.
2. Llama a `iniciar_liquidacion_tramo(tramo_id)` (`service_role`) → `PA021`/`PA022`/`PA023` si
   corresponde (respuesta inmediata, no se llega a tocar Stellar).
3. Lee del tramo: `unidad_minima_aporte` (del pool), `rendimiento_ilustrativo_plazo_pct`,
   `token_contract_id`, y la wallet de custodia del pool (`obtener_secreto_custodia_pool`, mismo
   RPC que ya usa `confirmar-aporte`).
4. Para cada `{ investor_id, wallet_public_key }` de la lista devuelta por el paso 2, **de forma
   secuencial e independiente** (un fallo en uno no detiene a los siguientes):
   1. `fracciones = await consultarSoloLectura(token_contract_id, "balance", [wallet_public_key])`
      (FR-004 — nunca un valor derivado de `aportes`).
   2. Si `fracciones === 0`: llama `registrar_pago_liquidacion(tramo_id, investor_id, 0, 0, moneda,
      null, null)` y pasa al siguiente inversionista (no hay nada que pagar ni quemar).
   3. `monto = fracciones * unidad_minima_aporte * (1 + rendimiento_ilustrativo_plazo_pct / 100)`
      (FR-005).
   4. `obtener_secreto_wallet(investor_id)` (mismo RPC que ya usa `confirmar-aporte` para pagar el
      aporte del inversionista) → `secretoInversionista`.
   5. `{ hash: txPago } = await pagarXlm(secretoCustodia, wallet_public_key, monto)` (FR-006).
   6. `{ hash: txQuema } = await invocarContratoAdminConReintentos(secretoInversionista,
      token_contract_id, "burn", [wallet_public_key, fracciones])` (FR-007) — el nombre del
      parámetro es histórico (`secretoAdmin`); la función no valida de quién es la llave, solo la
      usa para firmar.
      - **Éxito**: `registrar_pago_liquidacion(tramo_id, investor_id, fracciones, monto, moneda,
        txPago, txQuema)`.
      - **Fallo tras 3 intentos**: el pago XLM ya se ejecutó (paso 4.5) pero la quema no —
        revertirlo: `{ hash: txReembolso } = await pagarXlm(secretoInversionista,
        walletCustodia, monto)` (inversionista → custodia, dirección inversa), luego
        `registrar_liquidacion_compensada(tramo_id, investor_id, fracciones, monto, moneda,
        "fallo_quema_onchain", txPago, null)`.
      - Si el propio paso 4.5 (`pagarXlm`) falla: no hubo pago que revertir —
        `registrar_liquidacion_compensada(tramo_id, investor_id, fracciones, monto, moneda,
        "fallo_pago_xlm", null, null)`.
5. Una vez procesados todos los inversionistas de la lista: `finalizar_liquidacion_tramo(tramo_id)`
   (FR-010).
6. Responde con el resultado agregado.

## Salida

**Éxito** (`200`) — incluye tanto inversionistas pagados como compensados, nunca oculta un fallo
parcial:

```json
{
  "ok": true,
  "tramo_id": "uuid",
  "estado_liquidacion": "liquidado",
  "resultados": [
    {
      "investor_id": "uuid",
      "fracciones": 32,
      "monto_pagado": 3510.40,
      "estado": "pagado",
      "tx_hash_pago": "abc...",
      "tx_hash_quema": "def..."
    },
    {
      "investor_id": "uuid",
      "fracciones": 8,
      "monto_pagado": 877.60,
      "estado": "compensado",
      "motivo": "fallo_quema_onchain"
    }
  ]
}
```

**Fallo antes de procesar ningún inversionista** (`400`/`403`/`404`):

```json
{ "ok": false, "error": { "code": "PA022", "message": "El tramo tiene facturas sin cobrar: [\"uuid1\", \"uuid2\"]." } }
```

## Fuera de este contrato

- No decide cuándo una factura está "cobrada" — eso sigue siendo `actualizar_estado_cobro_factura`
  (ya existente, FR-023 de la spec de originación), que el operador debe haber usado antes, factura
  por factura, para todas las que respaldan el tramo.
- No calcula ni reparte pérdidas entre tramo senior y junior — cada tramo se liquida de forma
  completamente independiente, con su propio rendimiento ilustrativo ya sembrado.
- No permite liquidar una sola factura ni un monto parcial — siempre paga el 100% del balance real
  de cada inversionista en ese tramo.
