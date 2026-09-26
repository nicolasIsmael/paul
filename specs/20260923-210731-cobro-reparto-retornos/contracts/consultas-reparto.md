# Contrato: consultas de cobro y reparto (RPC de solo lectura)

Migración `0023_consultas_reparto.sql`. Todas `security definer`, `stable`,
`set search_path = ''`, `revoke all` a `public`/`anon`, `grant execute` a `authenticated`, con la
verificación de rol **dentro** de la función (nunca confían en el cliente). Ninguna mueve estado.

## `mis_repartos()` — inversionista (FR-026)

Sin parámetros; siempre `auth.uid()`. Una fila por posición en un tramo con reparto iniciado:

| Campo | Descripción |
|-------|-------------|
| `pool_id`, `pool_nombre`, `tramo_tipo` | identificación |
| `capital_xlm` | XLM aportados al tramo |
| `ajuste_xlm` | parte del rendimiento (+) o pérdida (−) |
| `monto_xlm` | lo que se le paga |
| `estado_pago` | `pendiente` \| `pagado` \| `fallido` |
| `tx_hash` | transacción real de Stellar testnet (verificable en Horizon) |
| `tipo_cambio_aplicado`, `moneda` | para mostrar la equivalencia en soles/dólares en el front |
| `pagado_at`, `pagado_efectivo_at` | fecha real / del reloj del pool |
| `reparto_estado` | `en_curso` \| `cerrado` |

Un inversionista solo ve sus propias filas. Ve el estado de su pago aunque el reparto siga
`en_curso`.

## `mis_posiciones()` (extendida)

Agrega `reparto_estado` (`sin_reparto` \| `en_curso` \| `cerrado`), `monto_pagado_xlm` y
`pago_tx_hash`. Los campos existentes no cambian (compatibilidad con las features previas).

## `estado_reparto_pool(p_pool_id)` — operador

`jsonb` con: la liquidación (`tipo_cambio_aplicado`, `perdida_xlm`, cascada `perdida_junior_xlm`/
`perdida_senior_xlm`, `forzada`), por tramo (`reparto_estado`, `origen`,
`n_pagos`, `n_pagados`, `total_a_pagar_xlm`, `total_pagado_xlm`), y la
lista de facturas marcadas por cierre forzado. Rol distinto de operador → `PA008`.

## `listar_pagos_reparto(p_tramo_id)` — operador

Una fila por pago: inversionista (nombre), `monto_xlm`, `estado`, `intentos`, `tx_hash`,
`motivo_fallo`. Sirve para decidir cuándo reintentar con `repartir-tramo`.

## `detalle_pool` / `facturas_del_pool` (extendidas)

Se agregan, sin quitar ni renombrar campos existentes:

- Por pool: `fecha_efectiva` (`ahora_pool`), `pool_vencido` (`hoy_pool >= fecha_vencimiento_esperada`)
  y, por tramo, `reparto_estado`.
- Por factura (versión anonimizada, **sin** proveedor ni deudor — FR-020/FR-021 de la spec de
  originación): `vencida` (`hoy_pool > fecha_vencimiento`), y `estado_cobro` ya existente.

Con el reloj sin adelantar, `fecha_efectiva = now()` y `vencida`/`pool_vencido` reflejan el
calendario real (Historia 4, escenario 1).
