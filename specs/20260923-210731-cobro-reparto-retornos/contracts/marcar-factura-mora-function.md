# Contrato: Edge Function `marcar-factura-mora`

Marca una factura asignada como `en_mora` (demuestra que el tramo junior absorbe la pérdida).
**Sin movimiento de dinero.** Es Edge Function y no RPC directa porque, igual que el cobro, puede
completar el estado final del pool y por tanto disparar el reparto automático (FR-017), que sí
mueve XLM. `verify_jwt = true`. Cubre FR-004 y FR-005.

## Entrada

```http
POST /functions/v1/marcar-factura-mora
Authorization: Bearer <jwt del operador de banco>
Content-Type: application/json

{ "factura_id": "uuid" }
```

## Procesamiento

1. JWT + `perfiles.rol = 'operador_banco'` → `403 PA008`.
2. `marcar_factura_en_mora(factura_id, operador_id, false)` (`service_role`, `FOR UPDATE`):
   - no encontrada → `PA016`; no asignada / rechazada / ya en estado final → `PA031`; tramo ya
     repartido → `PA032`.
   - `estado_cobro = 'en_mora'`, `estado_final_at`, `estado_final_efectivo_at`,
     `estado_final_por`. Si la factura ya estaba `en_mora` **por este mismo operador** y la llamada
     es un reintento → responde el estado actual (`ya_existia: true`).
3. `evaluar_reparto_pool(pool_id)` → si es elegible, `ejecutarRepartoPool` como en
   `cobrar-factura` (paso 6 de ese contrato).

## Salida

```json
{
  "ok": true,
  "factura": { "id": "uuid", "estado_cobro": "en_mora", "cierre_forzado": false },
  "reparto": { "disparado": false, "motivo": "Faltan 2 facturas del pool por resolver" }
}
```

## Errores

`403 PA008` · `400 PA012` · `404 PA016` · `409 PA031` · `409 PA032` (mismos significados que
`cobrar-factura`).

## Notas

- La mora es **definitiva**: no existe transición `en_mora → cobrada` (FR-021, guardia `PA030`).
  Un cobro tardío de una factura ya en mora se rechaza.
- La mora por **cierre forzado** (facturas pendientes que se convierten en mora al forzar un
  reparto) no pasa por esta función: la hace `forzar_reparto_pool` dentro de `repartir-tramo`,
  con `cierre_forzado = true`.
