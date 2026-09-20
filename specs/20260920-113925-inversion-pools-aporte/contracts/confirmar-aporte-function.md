# Contrato: Edge Function `confirmar-aporte`

Invocada **directamente por el cliente autenticado** (a diferencia de `provision-investor-wallet`,
que solo la invoca un Database Webhook) — es el único punto de entrada que efectivamente mueve
dinero. Cubre el resto de Historia 4 (FR-024 a FR-034): reserva → pago en XLM testnet →
confirmación/reversión, todo de forma **síncrona** (FR-034: la respuesta HTTP de esta función ES
el resultado final, nunca "queda pendiente"). Desplegada con `verify_jwt = true` (a diferencia de
`provision-investor-wallet`): el propio JWT del inversionista autentica la llamada, sin necesitar
el mecanismo de secreto compartido que sí hace falta para un trigger de base de datos.

## Entrada

```http
POST /functions/v1/confirmar-aporte
Authorization: Bearer <jwt del inversionista>
Content-Type: application/json

{
  "cotizacion_id": "uuid",
  "idempotency_key": "uuid"   // generado por el cliente, el mismo en cada reintento/doble clic
}
```

## Procesamiento (orquestación síncrona, ver `research.md` §1 y §3)

1. Valida el JWT (automático, `verify_jwt = true`) y confirma vía `perfiles.rol = 'inversionista'`
   (RPC `service_role`) — si no, `403` con `PA008`.
2. Llama a la función interna `reservar_aporte(p_cotizacion_id, p_investor_id, p_idempotency_key)`
   (`service_role`, ver `data-model.md` — ciclo de vida del Aporte). Esta llamada, en **una sola
   transacción de base de datos**:
   - Si ya existe un aporte con esa `(investor_id, idempotency_key)`, devuelve su estado actual
     en vez de crear uno nuevo (garantiza que un reintento nunca duplica — Historia 4 escenario 8).
   - Si no, valida cotización (existe, es de este inversionista, no expiró, no usada — `PA004`/
     `PA005`), valida saldo de demostración suficiente (`PA002`), descuenta atómicamente el cupo
     del tramo (`PA003` si ya no cabe), descuenta el saldo de demostración, marca la cotización
     `usada = true`, inserta el `aporte` en estado `reservado`.
   - Si esta llamada falla con cualquiera de esos códigos, la función **no llega a tocar la red
     Stellar** y responde de inmediato con el fallo (paso 6).
3. Con la reserva creada, lee `wallet_public_key`/`obtener_secreto_wallet(investor_id)` (interna,
   `service_role`) y `pools.custody_public_key` del pool de la cotización.
4. Consulta el balance XLM actual de la billetera del inversionista contra Horizon testnet. Si
   `balance - monto_xlm < 2` (reserva mínima, ver Clarifications de la spec), llama a
   `revertir_aporte(aporte_id, 'xlm_insuficiente')` (libera cupo y saldo demo) y responde `PA009`
   — **sin someter ninguna transacción**.
5. Construye y somete una operación `Payment` (XLM nativo) desde la billetera del inversionista
   hacia `pools.custody_public_key` por `monto_xlm`, firmada con el secreto leído del paso 3, con
   un timeout interno de 25s (research.md §3).
   - **Éxito** (`successful: true`, hash obtenido): llama a
     `confirmar_aporte(aporte_id, tx_hash)` (`service_role`) — marca `estado = 'confirmado'`,
     `xlm_pagados`, `tx_hash`, `confirmado_at`. El cupo y el saldo demo **no** se vuelven a tocar
     aquí — ya se comprometieron en el paso 2.
   - **Fallo** (rechazo de Horizon, timeout, error de red): llama a
     `revertir_aporte(aporte_id, 'fallo_red_stellar')` (libera cupo y saldo demo) y responde
     `PA013`.
6. Responde con el resultado final (éxito o fallo) en el mismo request — nunca deja el aporte en
   `reservado` de cara al cliente.

## Salida

**Éxito** (`200`):

```json
{
  "ok": true,
  "aporte": {
    "id": "uuid",
    "pool_id": "uuid",
    "tramo_tipo": "senior",
    "monto_nominal": 300.00,
    "moneda": "PEN",
    "xlm_pagados": 833.3333333,
    "tipo_cambio_aplicado": 0.36,
    "confirmado_at": "2026-09-20T18:02:11Z"
  },
  "comprobante": {
    "tx_hash": "abc123...",
    "red": "stellar-testnet",
    "simulado": false
  }
}
```

Si el mecanismo de comprobante on-chain todavía no está disponible (contingencia documentada en
la spec), `comprobante.simulado = true`, `comprobante.tx_hash = null`, y el cliente **debe**
rotularlo como simulado, nunca presentarlo como evidencia real (FR-033).

**Fallo** (`400`/`409`):

```json
{ "ok": false, "error": { "code": "PA003", "message": "...", "cupo_disponible": 120.00 } }
```

Mismo registro de códigos que `data-model.md` — el cliente puede confiar en `error.code` para
decidir qué mostrar, sin parsear `error.message`.

## Fuera de este contrato

- No expone ni recibe nunca la llave privada del inversionista ni la de custodia del pool — ambas
  se leen server-side, dentro de la propia función, y nunca salen en la respuesta.
- No implementa reintento automático del pago Stellar — si `PA013` (fallo de red), el cliente
  debe volver a llamar con una **cotización nueva** (la reservada ya se revirtió) y,
  opcionalmente, el mismo `idempotency_key` si quiere que un reintento accidental del propio
  request no duplique nada.
- No decide cómo se liquida el pool al vencimiento — eso es una feature posterior (fuera de
  alcance de la spec).
