# Contrato: Edge Function `repartir-tramo`

Ejecuta el reparto de **un tramo**. Un mismo punto de entrada cubre tres usos: **forzar** el
reparto (operador), **reintentar/continuar** un reparto `en_curso` y **disparar** manualmente uno
elegible. El disparo automático no llama a esta función por HTTP: `cobrar-factura` y
`marcar-factura-mora` invocan directamente el módulo compartido `_shared/reparto-pagos.ts`, que
esta función también usa. `verify_jwt = true`. Cubre Historias 2 y 3 (FR-011 – FR-026).

## Entrada

```http
POST /functions/v1/repartir-tramo
Authorization: Bearer <jwt del operador de banco>
Content-Type: application/json

{ "tramo_id": "uuid", "forzar": false }
```

- `forzar: true` — marca en mora (`cierre_forzado`) todas las facturas pendientes **del pool** del
  tramo y ejecuta el reparto (FR-018). Solo operador.
- `forzar: false` (default) — solo procede si el reparto ya está `en_curso` (continuar/reintentar)
  o si el pool ya es elegible; si hay facturas pendientes y no se forzó → `409 PA036`.

## Procesamiento (`ejecutarRepartoPool`)

1. JWT + rol operador → `403 PA008`. Tramo inexistente → `404 PA012`.
2. Si `tramos.reparto_estado = 'cerrado'` → `409 PA032` (irreversible; FR-021). Ninguna
   transacción se genera.
3. Si `forzar`: `forzar_reparto_pool(pool_id, operador_id)` (una transacción; registra qué facturas
   pasaron a mora). Sin inversionistas en el tramo → `409 PA036`.
4. **Liquidación del pool** (una vez por pool, en SQL):
   - Coherencia: `Σ fracciones` de aportes confirmados del tramo = `total_supply` del token del
     tramo (`consultarSoloLectura`) → si no, `409 PA038`, sin pagos.
   - `preparar_liquidacion_pool(pool_id, forzada)` fija la tasa, calcula capital/rendimiento/pérdida
     en XLM y la cascada senior/junior, y guarda la "foto" en `liquidaciones_pool` (una por pool;
     llamarla de nuevo devuelve la misma fila sin recalcular).
5. `iniciar_reparto_tramo(tramo_id, origen, operador)` → `repartos_tramo` (`unique(tramo_id)`,
   advisory lock) y `crear_pagos_reparto(reparto_id)` (idempotente). Ambos no-ops si ya existen.
6. **Fondos**: `saldoCustodia − 1.5 XLM ≥ pagos pendientes del tramo + comprometidos del otro`;
   si no → `402 PA035` con `{ requerido_xlm, disponible_xlm }`. El reparto queda `en_curso`.
7. **Pagos** (uno por inversionista, secuenciales bajo `conLockFirma(custodia)`, hasta ~100 s):
   por cada pago de `tomar_pagos_pendientes`: si ya tiene `tx_hash` y `existeTransaccion` →
   `confirmar_pago_reparto` sin pagar de nuevo; si no: `prepararPagoXlm(secretoCustodia,
   wallet_destino, monto_xlm, memo "rep:<8 primeros del pago_id>")` → `registrar_tx_pago_reparto`
   **antes** de enviar → enviar → `confirmar_pago_reparto`. Error → `existeTransaccion` para
   desambiguar; si no existe, `fallar_pago_reparto(motivo)` y **continúa con el siguiente**
   (un fallo no detiene a los demás).
8. **Cierre**: si `n_pagados = n_pagos` → `cerrar_reparto_tramo(reparto_id)` (tramo `cerrado`,
   irreversible). Si quedan pagos `fallido` o `pendiente`, el tramo **no** se cierra (FR-022).

## Salida

```json
{
  "ok": true,
  "reparto": {
    "id": "uuid", "tramo_id": "uuid", "origen": "forzado", "estado": "cerrado",
    "total_pagado_xlm": "12345.6789012", "n_pagos": 3, "n_pagados": 3, "pagos_restantes": 0
  },
  "liquidacion": {
    "tipo_cambio_aplicado": 0.36, "perdida_xlm": "10000.0000000",
    "perdida_junior_xlm": "5000.0000000", "perdida_senior_xlm": "5000.0000000"
  },
  "pagos": [
    { "investor_id": "uuid", "monto_xlm": "…", "estado": "pagado", "tx_hash": "…" }
  ]
}
```

Con `pagos_restantes > 0` (presupuesto de tiempo agotado o pagos `fallido`) la respuesta es `200`
con `estado: "en_curso"`; el cliente vuelve a llamar con el mismo cuerpo hasta `pagos_restantes: 0`.
Es seguro repetir: nunca se paga dos veces a un inversionista.

## Errores

| HTTP | Código | Causa |
|------|--------|-------|
| 401/403 | `PA008` | sin sesión / rol incorrecto |
| 400/404 | `PA012` | cuerpo inválido / tramo no encontrado |
| 409 | `PA032` | el tramo ya está `cerrado`, o ya fue liquidado por `liquidar-tramo` (`estado_liquidacion <> 'activo'`) |
| 409 | `PA036` | no elegible (pool sin facturas, tramo sin inversionistas, facturas pendientes sin `forzar`) |
| 409 | `PA038` | fracciones de Postgres ≠ `total_supply` on-chain |
| 402 | `PA035` | custodia insuficiente |
| 502 | `PA034` | falló algún pago (los demás continuaron; ver `pagos`) |

## Garantías

- **Único e irreversible por tramo**: `unique(repartos_tramo.tramo_id)` en Postgres +
  guardia `PA032` en cobro/mora + exclusión mutua con `liquidar-tramo` (spec `liquidacion-tramo`).
- **Un pago por inversionista**: `unique(pagos_reparto.reparto_id, investor_id)`, hash guardado
  antes del envío, conciliación contra Horizon.
- **Parcial y reintentable** (decisión 4): estados por pago; el tramo se cierra solo con el 100 %
  `pagado`.
- **Sin pagos con el sistema inconsistente**: coherencia de fracciones y fondos verificados antes
  del primer pago.
