# Data Model: Liquidación de Tramo (Cobro Simulado, Camino Feliz)

`numeric` para soles/dólares y XLM (mismo estándar que las specs previas); `integer` para
fracciones (nunca `numeric`, mismo invariante de la spec de originación).

## `public.tramos` (existente — columna nueva)

```sql
alter table public.tramos
  add column estado_liquidacion text not null default 'activo'
    check (estado_liquidacion in ('activo', 'liquidando', 'liquidado'));
```

**Ciclo de vida**:

```
activo ──iniciar_liquidacion_tramo()──► liquidando ──finalizar_liquidacion_tramo()──► liquidado
  │                                                                                      (terminal)
  └─ FR-011: rechaza iniciar_liquidacion_tramo() si ya no está en 'activo'
```

`liquidado` es terminal (FR-010) — ningún flujo lo revierte, igual que `facturas.estado_asignacion
= 'asignada'` en la spec de originación (mismo principio de irreversibilidad una vez confirmado).

## `public.liquidaciones_tramo_inversionista` (nueva)

```sql
create table public.liquidaciones_tramo_inversionista (
  id uuid primary key default gen_random_uuid(),
  tramo_id uuid not null references public.tramos(id),
  investor_id uuid not null references public.perfiles(id),
  fracciones integer not null check (fracciones >= 0),
  monto_pagado numeric(14, 2) not null check (monto_pagado >= 0),
  moneda text not null,
  tx_hash_pago text,
  tx_hash_quema text,
  estado text not null check (estado in ('pagado', 'compensado')),
  motivo_compensacion text,
  created_at timestamptz not null default now(),
  unique (tramo_id, investor_id)
);
```

- `fracciones` = el `balance()` real leído on-chain en el momento de liquidar (FR-004) — nunca un
  valor derivado de `aportes`.
- `monto_pagado` = `fracciones * unidad_minima_aporte * (1 + rendimiento_ilustrativo_plazo_pct/100)`
  (FR-005). Si `fracciones = 0` (inversionista con aporte confirmado en Postgres pero balance real
  en 0), `monto_pagado = 0` y de todas formas se registra la fila — deja evidencia de que esa
  persona fue revisada durante la liquidación, no que se la salteó por error.
- `tx_hash_pago` / `tx_hash_quema`: nulos solo cuando `estado = 'compensado'` y el fallo ocurrió
  antes de someter esa transacción en particular (ej. si `pagarXlm` nunca llegó a ejecutarse porque
  `consultarSoloLectura` ya había fallado).
- La restricción `unique (tramo_id, investor_id)` es lo que hace segura la reanudación de una
  liquidación interrumpida (ver plan.md → Riesgos): la Edge Function debe saltarse a cualquier
  inversionista que ya tenga una fila para ese tramo antes de reprocesarlo.
- No hay `updated_at` ni edición posterior — cada fila es un hecho histórico inmutable, igual que
  `aportes` en la spec previa.

## Funciones RPC nuevas (`SECURITY DEFINER`, mismo patrón que las specs previas)

### `iniciar_liquidacion_tramo(p_tramo_id uuid) returns jsonb`

1. Exige rol `operador_banco` (mismo guard que `asignar_factura_a_pool`).
2. Rechaza si `tramos.estado_liquidacion <> 'activo'` (FR-011).
3. Rechaza si existe alguna factura con `tramo_id = p_tramo_id` y `estado_cobro <> 'cobrada'`
   (FR-003) — devuelve cuáles facturas faltan, para que el operador sepa qué falta.
4. Marca `tramos.estado_liquidacion = 'liquidando'`.
5. Devuelve la lista de inversionistas distintos con al menos un aporte `confirmado` en ese tramo
   (`investor_id`, `wallet_public_key`), excluyendo a quienes ya tengan una fila en
   `liquidaciones_tramo_inversionista` para este tramo (idempotencia de reanudación).
6. Si la lista es vacía (tramo sin aportes, o todos ya procesados), la Edge Function puede llamar
   `finalizar_liquidacion_tramo` de inmediato (FR-009, Historia 3).

### `registrar_pago_liquidacion(p_tramo_id uuid, p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_tx_pago text, p_tx_quema text) returns void`

Inserta una fila en `liquidaciones_tramo_inversionista` con `estado = 'pagado'`. Llamada por la
Edge Function después de que el pago XLM y la quema on-chain de ese inversionista salieron bien.

### `registrar_liquidacion_compensada(p_tramo_id uuid, p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_motivo text, p_tx_hash_pago text default null, p_tx_hash_quema text default null) returns void`

Inserta una fila con `estado = 'compensado'` (FR-008). `p_motivo` guarda el error real (ej.
`soroban_tx_failed`, `timeout_soroban_confirmacion`) para depuración posterior.

### `finalizar_liquidacion_tramo(p_tramo_id uuid) returns void`

Marca `tramos.estado_liquidacion = 'liquidado'`. Llamada por la Edge Function una sola vez, después
de haber procesado (pagado o compensado) a todos los inversionistas devueltos por
`iniciar_liquidacion_tramo`.

## Cobertura de requisitos

| Requisito | Cubierto por |
|---|---|
| FR-001, FR-002 | Guard de rol `operador_banco` en `iniciar_liquidacion_tramo` |
| FR-003 | Paso 3 de `iniciar_liquidacion_tramo` (chequeo de `estado_cobro` de todas las facturas del tramo) |
| FR-004 | `consultarSoloLectura(..., "balance", ...)` en la Edge Function, antes de calcular cualquier monto |
| FR-005 | Fórmula de `monto_pagado`, calculada en la Edge Function con los datos ya sembrados del tramo |
| FR-006 | `pagarXlm` (custodia → inversionista) reutilizado tal cual |
| FR-007 | `invocarContratoAdminConReintentos(..., burn, ...)` firmando con el secreto del inversionista |
| FR-008 | `registrar_liquidacion_compensada` + reversión de pago vía `pagarXlm` (inversionista → custodia) cuando corresponde |
| FR-009 | Lista vacía de `iniciar_liquidacion_tramo` → `finalizar_liquidacion_tramo` directo |
| FR-010, FR-011 | Constraint `check` de `estado_liquidacion` + guard en `iniciar_liquidacion_tramo` |
