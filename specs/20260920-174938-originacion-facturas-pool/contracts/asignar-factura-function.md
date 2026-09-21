# Contrato: Edge Function `asignar-factura`

Invocada **directamente por el cliente autenticado** (operador de banco), igual patrón que
`confirmar-aporte`: la respuesta HTTP es siempre el resultado final, nunca queda "pendiente"
(mismo principio que FR-034 de la spec previa, aquí aplicado a la asignación). Desplegada con
`verify_jwt = true`. Cubre Historia 2 y Historia 3 (FR-006 – FR-018, FR-027).

## Entrada

```http
POST /functions/v1/asignar-factura
Authorization: Bearer <jwt del operador de banco>
Content-Type: application/json

{ "factura_id": "uuid", "tramo_id": "uuid", "anticipo": 4000.00 }
```

Sin `idempotency_key` explícito — `factura_id` ya es la clave natural de idempotencia (una
factura solo puede tener una asignación en curso o confirmada a la vez, `data-model.md` → Factura,
`facturas_asignacion_coherente`).

## Procesamiento

1. Valida el JWT y `perfiles.rol = 'operador_banco'` (`service_role`, defensa en profundidad) →
   `403 PA008` si no.
2. Llama a `asignar_factura_a_pool(p_factura_id, p_tramo_id, p_anticipo)` (`service_role`, **una
   sola transacción de base de datos**, mismo patrón que `reservar_aporte`):
   - Si la factura ya está `'pendiente_onchain'` o `'asignada'` para el mismo `tramo_id` y
     `anticipo` solicitados, devuelve el estado actual (`ya_existia: true`) sin repetir la
     aritmética — reintento seguro.
   - Si no existe o `estado_validacion <> 'aprobada'` → `PA016`.
   - Si `estado_asignacion <> 'sin_asignar'` con datos **distintos** a los solicitados (otro
     operador ganó la carrera) → `PA018`.
   - Si `p_anticipo <= 0` o `> monto_nominal` → `PA017`.
   - Calcula el nuevo `fracciones_totales`/`reserva`/`capital_objetivo` del tramo (`data-model.md`
     → tramos, `research.md` §6) con un `UPDATE` de una sola sentencia sobre `tramos` (mismo
     patrón de concurrencia atómica que `reservar_aporte`, `research.md` de la spec previa §1).
   - Marca la factura `estado_asignacion = 'pendiente_onchain'`, fija `tramo_id`/`pool_id`/
     `anticipo`.
   - Si cualquiera de estas validaciones falla, la función **no llega a invocar el contrato** y
     responde de inmediato (paso 5).
3. Con la reserva creada, lee `configuracion_red` (WASM hash irrelevante aquí, solo interesa la
   llave) + `obtener_secreto_autoridad_operador()` + `tramos.token_contract_id` del tramo
   destino.
4. Invoca `register_invoice(invoice_hash, nuevo_cap)` en el contrato de ese tramo
   (`_shared/stellar-soroban.ts`, `research.md` §4), con hasta 3 intentos y backoff corto
   (`research.md` §2):
   - **Éxito**: llama a `confirmar_asignacion_factura(factura_id, tx_hash)` (`service_role`) —
     marca `estado_asignacion = 'asignada'`, guarda `onchain_tx_hash`. Irreversible desde aquí
     (FR-012).
   - **Fallo tras 3 intentos, o el contrato rechaza con `CapCannotDecrease`/`InvoiceAlready
     Registered`** (no debería ocurrir dado el chequeo de duplicados de `registrar_factura`, pero
     se trata como fallo definitivo si ocurre): llama a `revertir_asignacion_factura(factura_id)`
     — libera `fracciones_totales`/`reserva`/`capital_objetivo` del tramo y devuelve la factura a
     `estado_asignacion = 'sin_asignar'` (queda `'aprobada'`, el operador puede reintentar con
     otro pool/tramo/anticipo) — responde `PA019`. A diferencia de `revertir_aporte`, no existe un
     motivo persistido en la fila (la factura vuelve a un estado reutilizable, no a uno rechazado
     permanente); el motivo del fallo solo se registra en los logs de la Edge Function.
5. Responde con el resultado final en la misma solicitud.

## Salida

**Éxito** (`200`):

```json
{
  "ok": true,
  "factura": {
    "id": "uuid",
    "estado_asignacion": "asignada",
    "pool_id": "uuid",
    "tramo_id": "uuid",
    "anticipo": 4000.00,
    "huella_hash": "ab12..."
  },
  "tramo_actualizado": {
    "fracciones_totales": 143,
    "reserva": 37.50,
    "capital_objetivo": 14300.00
  },
  "comprobante_onchain": { "tx_hash": "def456...", "red": "stellar-testnet", "contrato": "C..." }
}
```

**Fallo** (`400`/`409`):

```json
{ "ok": false, "error": { "code": "PA017", "message": "El anticipo no puede superar el valor nominal de la factura." } }
```

## Fuera de este contrato

- No decide a qué tramo va cada factura — esa decisión es siempre del operador, en la propia
  solicitud (`research.md` §8); la función no aplica ninguna fórmula de reparto.
- No revierte una asignación ya `'asignada'` — solo existe reversión mientras el estado es
  `'pendiente_onchain'` (FR-012, irreversibilidad).
- No emite fracciones a ningún inversionista — eso ocurre únicamente en `confirmar-aporte`
  (extensión descrita en `contracts/confirmar-aporte-extension.md`), cuando un inversionista aporta
  contra el cupo que esta función acaba de habilitar.
