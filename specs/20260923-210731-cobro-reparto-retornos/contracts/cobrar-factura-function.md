# Contrato: Edge Function `cobrar-factura`

Simula el pago del deudor con una **transacción real de Stellar testnet**: XLM de la cuenta deudor
única hacia la custodia del pool de la factura. Invocada directamente por el operador de banco;
`verify_jwt = true` (entrada en `supabase/config.toml`). La respuesta HTTP es siempre el resultado
final del cobro (nunca "pendiente"), igual que `asignar-factura`. Cubre Historia 1 (FR-001 –
FR-010) y dispara el reparto automático (FR-017) cuando corresponde.

## Entrada

```http
POST /functions/v1/cobrar-factura
Authorization: Bearer <jwt del operador de banco>
Content-Type: application/json

{ "factura_id": "uuid" }
```

`factura_id` es la clave natural de idempotencia: hay como máximo un cobro vivo por factura
(índice único parcial en `cobros_factura`).

## Procesamiento

1. Valida el JWT y `perfiles.rol = 'operador_banco'` → `403 PA008`.
2. **Cuenta deudor**: `_shared/cuenta-deudor.ts` la aprovisiona la primera vez (keypair →
   `aprovisionar_cuenta_deudor` → Friendbot una sola vez). Idempotente.
3. `iniciar_cobro_factura(factura_id, operador_id)` (`service_role`, una transacción, `FOR UPDATE`):
   - factura inexistente → `PA016`; no asignada / rechazada / ya `cobrada` o `en_mora` → `PA031`;
     tramo ya repartido → `PA032`.
   - si ya existe un cobro `confirmado` → responde ese cobro (`ya_existia: true`, reintento seguro);
     si existe uno `reservado` → lo reanuda (paso 5) en vez de crear otro.
   - crea `cobros_factura` en `reservado` con `monto_xlm = round(monto_nominal / tasa, 7)`, la tasa
     vigente y la custodia destino (`pools.custody_public_key`).
4. **Fondos**: `obtenerBalanceXlm(cuentaDeudor) − 1.5 ≥ monto_xlm`; si no, repone vía Friendbot +
   `accountMerge` (hasta 3 veces, `research.md` §4). Si sigue sin alcanzar → `fallar_cobro_factura`
   y `402 PA033` con `{ requerido_xlm, disponible_xlm }`. La factura permanece `pendiente`.
5. **Pago**: dentro de `conLockFirma(cuentaDeudor)`: `prepararPagoXlm(secretoDeudor, custodia,
   monto_xlm, memo "cobro:<8 primeros del cobro_id>")` → `registrar_tx_cobro(hash, xdr)` **antes**
   de enviar → `enviarTransaccionXdr`.
   - Éxito → `confirmar_cobro_factura` (factura → `cobrada`, `estado_final_*`, fecha efectiva del
     pool).
   - Error o timeout → `existeTransaccion(hash)`: si `true`, confirma igual; si `false`,
     `fallar_cobro_factura(motivo)` → `502 PA034` (la factura sigue `pendiente`, reintentable).
6. **Reparto automático**: `evaluar_reparto_pool(pool_id)`; si es elegible, ejecuta
   `_shared/reparto-pagos.ts → ejecutarRepartoPool` hasta su presupuesto de tiempo y añade el
   resumen a la respuesta. Un fallo del reparto **no** revierte el cobro (ya es dinero movido):
   se informa en `reparto.error` y se puede reintentar con `repartir-tramo`.

## Salida (éxito)

```json
{
  "ok": true,
  "factura": { "id": "uuid", "estado_cobro": "cobrada" },
  "cobro": {
    "id": "uuid", "monto_nominal": 20000, "moneda": "PEN",
    "monto_xlm": "55555.5555556", "tipo_cambio_aplicado": 0.36,
    "cuenta_origen": "G…deudor", "cuenta_destino": "G…custodia",
    "tx_hash": "…", "red": "stellar-testnet",
    "confirmado_at": "…", "confirmado_efectivo_at": "…"
  },
  "reparto": { "disparado": true, "tramos": [ { "tramo": "junior", "estado": "cerrado", "pagos_restantes": 0 } ] }
}
```

`reparto.disparado = false` con `motivo` cuando aún faltan facturas por resolver.

## Errores

| HTTP | Código | Causa |
|------|--------|-------|
| 401/403 | `PA008` | sin sesión o rol distinto de operador de banco |
| 400 | `PA012` | cuerpo inválido |
| 404 | `PA016` | factura no encontrada |
| 409 | `PA031` | factura no cobrable (no asignada, rechazada o ya en estado final) |
| 409 | `PA032` | el tramo de la factura ya fue repartido |
| 402 | `PA033` | fondos del deudor insuficientes tras reponer |
| 502 | `PA034` | falló la transferencia on-chain; la factura sigue `pendiente` |

## Garantías

- **Cobrada ⇒ hay transferencia confirmada**: el trigger `facturas_guardia_estado_cobro` y la
  única vía de escritura (`confirmar_cobro_factura`) hacen imposible marcar `cobrada` sin un
  `cobros_factura.estado = 'confirmado'` con `tx_hash` (FR-003).
- **Un solo cobro por factura** bajo doble clic, reintento o concurrencia (FR-007): índice único +
  `FOR UPDATE`; el pago nunca se reconstruye distinto, se reenvía el mismo XDR o se concilia.
- **Serialización de firma**: todos los pagos de la cuenta deudor pasan por `conLockFirma`.
