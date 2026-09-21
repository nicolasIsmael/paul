# Contrato: RPC `facturas_del_pool` + extensión de `detalle_pool`

Cubre Historia 4 y Historia 5 (FR-019 – FR-026). Ambas son funciones de solo lectura, `security
definer`, invocadas directamente por el cliente (inversionista u operador).

## `facturas_del_pool` (nueva)

```sql
facturas_del_pool (p_pool_id uuid) returns table (
  factura_id uuid,
  monto_nominal numeric,
  moneda public.moneda_soportada,
  sector public.sector_empresa,
  fecha_vencimiento date,
  dias_plazo integer,
  estado_cobro public.estado_cobro_factura
)
```

- Grant a `authenticated` (cualquier rol puede consultarla — no hay información sensible en su
  resultado).
- `where f.pool_id = p_pool_id and f.estado_asignacion = 'asignada'` — solo facturas ya
  confirmadas on-chain forman parte de "lo que respalda el pool" (una factura `'pendiente_
  onchain'` todavía podría revertirse, FR-012, así que no se muestra como respaldo hasta ser
  definitiva).
- `join empresas_pagadoras e on e.id = f.empresa_id` **solo** para proyectar `e.sector` — la
  sentencia `select` nunca menciona `e.nombre_comercial` ni `p.nombre_comercial` (proveedor); esa
  omisión en el propio código SQL, sumada al `revoke all` de `data-model.md`, es la garantía de
  FR-020 (dos capas independientes: ninguna vía de PostgREST llega a esas columnas, y aunque
  llegara, esta función no las selecciona).
- `dias_plazo := fecha_vencimiento - fecha_emision` — permite al inversionista comparar el plazo
  de cada factura contra el plazo propio del pool sin exponer la fecha de emisión real si no se
  quisiera (aquí se expone `fecha_vencimiento`, que sí es un campo pedido explícitamente por la
  spec; `fecha_emision` no se proyecta, ya que no es uno de los campos anonimizados listados en
  FR-019 — mantiene la anonimización mínima al conjunto de campos que la spec autoriza).

### Salida (una fila por factura asignada)

```json
{ "factura_id": "uuid", "monto_nominal": 4000.00, "moneda": "PEN", "sector": "retail", "fecha_vencimiento": "2026-10-20", "dias_plazo": 30, "estado_cobro": "pendiente" }
```

## Extensión de `detalle_pool` (`CREATE OR REPLACE`, no se edita `0009_catalogo_consultas.sql`)

Se agregan dos bloques al `jsonb` ya devuelto, calculados en vivo sobre `facturas` (sin columnas
agregadas denormalizadas — mismo estilo que `avance_pct`/`concentracion_maxima_pct` ya existentes):

```json
{
  "...": "... (todo lo ya existente, sin cambios) ...",
  "margen_plazo_dias": 5,
  "estado_facturas": {
    "pendientes": 3,
    "cobradas": 1,
    "en_mora": 0,
    "pct_cobrado": 22.5
  }
}
```

- `estado_facturas` cuenta únicamente facturas con `estado_asignacion = 'asignada'` del pool,
  agrupadas por `estado_cobro`; `pct_cobrado := sum(monto_nominal) filter (where estado_cobro =
  'cobrada') / sum(monto_nominal) * 100` (0 si el pool todavía no tiene facturas asignadas). Nunca
  incluye una cifra de rendimiento, retorno ni dividendo (FR-025) — es exclusivamente un conteo y
  un porcentaje de cobro, hechos verificables, no una proyección.
- `catalogo_pools`/`detalle_pool` también se actualizan (mismo `CREATE OR REPLACE`) para referenciar
  `facturas` en vez de `operaciones` tras el renombre (`research.md` §7) — sin cambio de
  comportamiento observable para el cliente, es puramente el rename interno.

## `actualizar_estado_cobro_factura` (nueva — escritura, soporte de Historia 5)

```sql
actualizar_estado_cobro_factura (p_factura_id uuid, p_nuevo_estado public.estado_cobro_factura) returns void
```

- Único punto de escritura de `facturas.estado_cobro` — sin esta función la tabla nunca cambiaría
  de estado tras asignarse, y el escenario 2 de Historia 5 ("una factura cambia de pendiente a
  cobrada o en mora") no sería demostrable.
- Rol: `operador_banco` únicamente (`PA008`) — igual que `registrar_factura`.
- Solo aplica sobre facturas con `estado_asignacion = 'asignada'` (`PA016` si no lo está — cambiar
  el estado de cobro de una factura que ni siquiera respalda un pool todavía no tiene sentido de
  negocio).
- No dispara ningún recálculo adicional ni notificación — `detalle_pool` ya agrega
  `estado_cobro` en vivo en cada lectura (`data-model.md`), así que un simple `UPDATE` basta para
  que el cambio se refleje de inmediato (SC-006).
- Grant a `authenticated` (chequeo de rol interno, mismo patrón que el resto de funciones de
  operador de esta feature).

## Fuera de este contrato

- No expone ninguna factura con `estado_asignacion` distinto de `'asignada'` — una factura
  `'aprobada'` sin asignar, o `'pendiente_onchain'`, no es "parte" de ningún pool todavía desde la
  perspectiva del inversionista.
- No calcula ni expone ningún rendimiento esperado a partir del estado de cobro — eso sigue
  viviendo exclusivamente en `rendimiento_ilustrativo_*` de `tramos`, ya existente y sin relación
  con `estado_cobro`.
