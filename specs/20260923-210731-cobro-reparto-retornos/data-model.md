# Data Model: Cobro de Facturas, Reparto de Retornos y Reloj de Demo

Extiende el modelo de las tres features previas (`perfiles`, `pools`, `tramos`, `facturas`,
`aportes`, `cotizaciones`, `tipos_cambio_referencia`, `configuracion_red`, `lock_firma_stellar`).
Toda tabla nueva: RLS habilitada + `revoke all` a `anon`/`authenticated`; el acceso es solo por
funciones (patrón de 0003/0011/0017). Migraciones: `0020`–`0026` (ver `plan.md` y `tasks.md`; `forzar_reparto_pool` va en `0024`).

## Códigos de error nuevos (`errcode`)

| Código | Significado |
|--------|-------------|
| `PA030` | Transición de estado de cobro no permitida (solo `pendiente → cobrada \| en_mora`) |
| `PA031` | Factura no cobrable: no está asignada, está rechazada o ya está en estado final |
| `PA032` | El tramo (o su pool) ya fue repartido — irreversible |
| `PA033` | Fondos insuficientes en la cuenta del deudor tras reponer |
| `PA034` | Fallo de la transferencia on-chain (cobro o pago de reparto) |
| `PA035` | Custodia del pool sin fondos suficientes para el reparto |
| `PA036` | Reparto no elegible (pool sin facturas, tramo sin inversionistas, facturas pendientes sin `forzar`) |
| `PA037` | Avance de reloj inválido (≤ 0 o sobre el tope) |
| `PA038` | Fracciones de Postgres ≠ `total_supply` on-chain del tramo |

Reutilizan los ya existentes: `PA008` (rol incorrecto), `PA012` (entrada inválida / no encontrado),
`PA016` (factura no encontrada).

## Reloj de demo (por pool)

### `reloj_pool`

| Columna | Tipo | Notas |
|---------|------|-------|
| `pool_id` | `uuid` PK, FK → `pools(id)` | una fila por pool, creada de forma perezosa en el primer avance |
| `desplazamiento` | `interval` NOT NULL default `'0'`, `check (desplazamiento >= interval '0')` | tiempo simulado acumulado sobre el reloj real |
| `updated_at` | `timestamptz` default `now()` | tiempo **real** (auditoría) |
| `actualizado_por` | `uuid` FK → `auth.users` null | operador del último avance |

### `reloj_pool_avances` (historial, solo inserción)

`id uuid PK`, `pool_id uuid FK`, `avance interval check (avance > interval '0')`,
`desplazamiento_antes interval`, `desplazamiento_despues interval`,
`fecha_efectiva_despues timestamptz`, `operador_id uuid FK`, `fecha_real_at timestamptz default now()`.

### Funciones de dominio

| Función | Acceso | Descripción |
|---------|--------|-------------|
| `ahora_pool(p_pool_id) → timestamptz` | interna (`stable`) | `now() + coalesce(desplazamiento, '0')` |
| `hoy_pool(p_pool_id) → date` | interna (`stable`) | fecha de `ahora_pool` en `America/Lima` |
| `avanzar_reloj_pool(p_pool_id, p_dias int, p_horas int default 0)` | operador | valida rol, `p_dias*24+p_horas > 0` y ≤ 366 días; actualiza `reloj_pool`, inserta en `reloj_pool_avances` |
| `estado_reloj_pool(p_pool_id) → jsonb` | operador/inversionista | `{ahora_real, ahora_efectivo, desplazamiento_dias, adelantado}` (FR-031) |

### Reglas que pasan a leer `ahora_pool` (redefinidas en 0020 con `create or replace`)

- `cotizar_aporte`: `cotizaciones.generado_at` y `expira_at = ahora_pool(pool) + 5 min` (el
  `default now() + 5 min` de la columna queda solo como respaldo para inserciones manuales).
- `reservar_aporte`: `aportes.reservado_at`/`expira_reserva_at = ahora_pool(pool) + 2 min`;
  **la limpieza de reservas vencidas** compara cada fila contra el reloj **de su propio pool**
  (`a.expira_reserva_at < public.ahora_pool(a.pool_id)`), y la vigencia de la cotización compara
  contra `ahora_pool(v_cot.pool_id)`.
- Sin cambios (reloj real, a propósito): tope diario de recargas, `lock_firma_stellar`, columnas
  `created_at`/`confirmado_at`/`revertido_at` de auditoría.

## Cuenta deudor de demo

### `cuenta_deudor_demo`

`singleton boolean PK default true check (singleton)`, `public_key text unique`,
`secret_id uuid unique` (Vault), `fondeada_at timestamptz` (primer Friendbot), `created_at`.
Funciones (solo `service_role`, patrón exacto de `tesoreria_stellar_demo`):
`aprovisionar_cuenta_deudor(p_public_key, p_secret_key) → jsonb` (idempotente, con advisory lock),
`obtener_cuenta_deudor() → jsonb`.

## Cobro de facturas

### Cambios en `facturas`

| Columna | Tipo | Notas |
|---------|------|-------|
| `cierre_forzado` | `boolean` NOT NULL default `false` | `true` si pasó a `en_mora` por un reparto forzado |
| `estado_final_at` | `timestamptz` null | tiempo **real** en que quedó `cobrada`/`en_mora` |
| `estado_final_efectivo_at` | `timestamptz` null | tiempo efectivo del pool en ese instante |
| `estado_final_por` | `uuid` null FK → `auth.users` | operador que la cobró o marcó en mora |

**Guardia** `facturas_guardia_estado_cobro` (trigger `BEFORE UPDATE OF estado_cobro`): solo admite
`pendiente → cobrada | en_mora`; cualquier otro cambio → `PA030`. Bloquea también el cambio si el
tramo de la factura ya está `cerrado` (`PA032`). `actualizar_estado_cobro_factura` (0013) **se conserva** (la usa la spec `liquidacion-tramo`).

### `cobros_factura`

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | |
| `factura_id` | `uuid` FK → `facturas` | |
| `pool_id`, `tramo_id` | `uuid` FK | denormalizados para consultas y auditoría |
| `monto_nominal` | `numeric` | en moneda del pool |
| `moneda` | `moneda_soportada` | |
| `tipo_cambio_aplicado` | `numeric` | `tasa_moneda_por_xlm` vigente al cobro |
| `monto_xlm` | `numeric(20,7)` `check > 0` | `round(monto_nominal / tasa, 7)` |
| `cuenta_origen` | `text` | pública de la cuenta deudor |
| `cuenta_destino` | `text` | pública de la custodia del pool |
| `estado` | `estado_cobro_stellar` (`reservado`, `confirmado`, `fallido`) | |
| `tx_hash`, `tx_xdr` | `text` null | guardados **antes** de enviar |
| `motivo_fallo` | `text` null | |
| `operador_id` | `uuid` FK → `auth.users` | |
| `created_at`, `confirmado_at` | `timestamptz` | reloj real |
| `confirmado_efectivo_at` | `timestamptz` null | reloj del pool |

Índices: **único parcial** `(factura_id) where estado in ('reservado','confirmado')` (a lo sumo un
cobro vivo por factura — FR-007); único parcial `(tx_hash) where tx_hash is not null`.

**Ciclo de vida**: `reservado → confirmado` (factura → `cobrada`) | `reservado → fallido`
(factura sigue `pendiente`, se puede reintentar creando otro cobro).

### Funciones (solo `service_role`)

`iniciar_cobro_factura(p_factura_id, p_operador_id)`, `registrar_tx_cobro(p_cobro_id, p_tx_hash,
p_tx_xdr)`, `confirmar_cobro_factura(p_cobro_id)`, `fallar_cobro_factura(p_cobro_id, p_motivo)`,
`marcar_factura_en_mora(p_factura_id, p_operador_id, p_cierre_forzado boolean default false)`.
Cada una toma `FOR UPDATE` sobre la factura y valida rol/estado; devuelven `jsonb` con el estado
resultante y los datos que la Edge Function necesita (cuenta destino, monto, tasa).

## Liquidación y reparto

### `liquidaciones_pool` (una por pool — la "foto" congelada de la cascada)

| Columna | Tipo | Notas |
|---------|------|-------|
| `pool_id` | `uuid` PK FK | garantiza una sola liquidación por pool |
| `tipo_cambio_aplicado` | `numeric` | tasa fijada al iniciar la liquidación (§ research 6) |
| `forzada` | `boolean` | |
| `capital_junior_xlm`, `capital_senior_xlm` | `numeric(20,7)` | `Σ xlm_pagados` de aportes confirmados por tramo |
| `rendimiento_junior_xlm`, `rendimiento_senior_xlm` | `numeric(20,7)` | rendimiento de facturas cobradas de cada tramo, convertido a XLM |
| `perdida_moneda` | `numeric` | `Σ anticipo` de facturas en mora del pool (moneda del pool) |
| `perdida_xlm` | `numeric(20,7)` | convertida a XLM |
| `perdida_junior_xlm`, `perdida_senior_xlm` | `numeric(20,7)` | resultado de la cascada calculada en SQL: `junior = least(perdida, capital_junior)`, `senior = least(perdida − junior, capital_senior)` |
| `created_at`, `fecha_efectiva_at` | `timestamptz` | real / reloj del pool |

### `repartos_tramo` (uno por tramo — el evento único)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | |
| `tramo_id` | `uuid` **unique** FK | un reparto por tramo, para siempre (FR-021/FR-023) |
| `pool_id` | `uuid` FK | |
| `origen` | `origen_reparto` (`automatico`, `forzado`) | |
| `forzado_por` | `uuid` null FK | |
| `estado` | `estado_reparto` (`en_curso`, `cerrado`) | `cerrado` solo con el 100 % de pagos `pagado` |
| `total_a_pagar_xlm` | `numeric(20,7)` | |
| `total_pagado_xlm` | `numeric(20,7)` default 0 | |
| `n_pagos`, `n_pagados` | `int` | |
| `created_at`, `cerrado_at` | `timestamptz` | real |
| `cerrado_efectivo_at` | `timestamptz` null | reloj del pool |

### `pagos_reparto` (uno por inversionista y reparto)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | |
| `reparto_id` | `uuid` FK | |
| `tramo_id`, `investor_id` | `uuid` FK | |
| **unique** `(reparto_id, investor_id)` | | nunca dos pagos al mismo inversionista |
| `wallet_destino` | `text` | `perfiles.wallet_public_key` |
| `fracciones` | `int` | |
| `capital_xlm` | `numeric(20,7)` | `Σ xlm_pagados` del inversionista en el tramo |
| `ajuste_xlm` | `numeric(20,7)` | parte del rendimiento (+) o pérdida (−) |
| `monto_xlm` | `numeric(20,7)` `check >= 0` | lo que se paga |
| `tipo_cambio_aplicado` | `numeric` | informativo, permite mostrar equivalencia en PEN/USD |
| `estado` | `estado_pago_reparto` (`pendiente`, `pagado`, `fallido`) | |
| `intentos` | `int` default 0 | |
| `tx_hash`, `tx_xdr` | `text` null | guardados antes de enviar |
| `motivo_fallo` | `text` null | |
| `pagado_at` | `timestamptz` null | real |

### Cambios en `tramos`

- `tramos.reparto_estado` `estado_reparto_tramo` (`sin_reparto` default, `en_curso`, `cerrado`):
  copia denormalizada mantenida solo por las funciones de reparto; permite guardias baratas
  (`PA032`) sin unir tablas. La fuente de verdad es `repartos_tramo`.

### Funciones de reparto (solo `service_role`)

| Función | Qué hace |
|---------|----------|
| `evaluar_reparto_pool(p_pool_id)` | Devuelve `{elegible, motivo, tramos:[…]}`: elegible si el pool tiene ≥ 1 factura asignada y **todas** en estado final; por tramo, si tiene inversionistas y no está cerrado (FR-017) |
| `forzar_reparto_pool(p_pool_id, p_operador_id)` | En una transacción: `pendiente → en_mora (cierre_forzado)` para todas las facturas del pool (registra cuáles); no ejecuta pagos |
| `preparar_liquidacion_pool(p_pool_id, p_forzada)` | Fija `tipo_cambio_aplicado`, calcula capital/rendimiento/pérdida en XLM **y la cascada senior/junior**, inserta o devuelve `liquidaciones_pool` (idempotente: una fila por pool) |
| `iniciar_reparto_tramo(p_tramo_id, p_origen, p_forzado_por)` | `FOR UPDATE` sobre el tramo + `insert … on conflict do nothing` en `repartos_tramo`; valida `PA032`/`PA036`; **rechaza (`PA032`) si `tramos.estado_liquidacion <> 'activo'`** (exclusión mutua con `liquidacion-tramo`); `tramos.reparto_estado = 'en_curso'` |
| `crear_pagos_reparto(p_reparto_id)` | Calcula el prorrateo (research §6) e inserta `pagos_reparto`; idempotente (`on conflict do nothing`) |
| `tomar_pagos_pendientes(p_reparto_id, p_limite)` | Devuelve pagos `pendiente`/`fallido` con `wallet_destino` y XDR previo, en orden estable |
| `registrar_tx_pago_reparto(p_pago_id, p_tx_hash, p_tx_xdr)` | Guarda hash+xdr antes del envío; `intentos += 1` |
| `confirmar_pago_reparto(p_pago_id)` | `pagado`, `pagado_at`; actualiza contadores del reparto |
| `fallar_pago_reparto(p_pago_id, p_motivo)` | `fallido`, con motivo |
| `cerrar_reparto_tramo(p_reparto_id)` | Solo si `n_pagados = n_pagos`: `estado = cerrado`, `tramos.reparto_estado = 'cerrado'`, fechas real/efectiva (FR-021/FR-022) |

## Consultas (0023)

| Función | Acceso | Devuelve |
|---------|--------|----------|
| `mis_repartos()` | inversionista (`auth.uid()`) | por tramo con reparto: pool, tramo, capital aportado (XLM), ajuste, monto pagado, estado del pago, `tx_hash`, tipo de cambio, fechas (FR-026) |
| `estado_reparto_pool(p_pool_id)` | operador | liquidación (cascada), por tramo estado del reparto, contadores, facturas marcadas por cierre forzado |
| `listar_pagos_reparto(p_tramo_id)` | operador | pagos con estado, intentos, hashes y `motivo_fallo` |
| `detalle_pool` / `facturas_del_pool` (extendidas) | inversionista/operador | añaden `fecha_efectiva`, `vencida` por factura y `pool_vencido` con `hoy_pool`, más `reparto_estado` por tramo |
| `mis_posiciones` (extendida) | inversionista | añade `reparto_estado`, `monto_pagado_xlm`, `pago_tx_hash` |

## Diagrama de estados

```text
factura.estado_cobro :  pendiente ──cobro confirmado on-chain──► cobrada
                        pendiente ──operador / cierre forzado──► en_mora        (irreversibles)

cobro_factura        :  reservado ──pago confirmado──► confirmado
                        reservado ──fallo / no existe en Horizon──► fallido    (reintentable)

reparto del tramo    :  (sin_reparto) ──todas final o forzado──► en_curso ──100 % pagos pagado──► cerrado

pago_reparto         :  pendiente ──► pagado
                        pendiente ──► fallido ──reintento──► pendiente ──► pagado
```

## Reglas de validación resumidas

- Cobro: `factura.estado_asignacion = 'asignada'` y `estado_cobro = 'pendiente'` y tramo
  `reparto_estado <> 'cerrado'`; monto = nominal completo (FR-002).
- Reparto automático: pool con ≥ 1 factura asignada y ninguna `pendiente`; tramo con ≥ 1 aporte
  confirmado; un tramo sin inversionistas se cierra sin pagos.
- Custodia: `saldo − 1.5 XLM ≥ Σ pagos pendientes de este tramo + Σ pagos comprometidos del
  otro tramo` (`PA035`).
- `Σ pagos del tramo ≤ capital + rendimiento − pérdida absorbida`: se verifica en SQL antes de
  insertar los pagos (`crear_pagos_reparto` aplica el factor de escala si hiciera falta).

## Exclusión mutua con `liquidacion-tramo` (migración `0022`)

`tramos.estado_liquidacion` (`activo`/`liquidando`/`liquidado`, spec `liquidacion-tramo`) y
`tramos.reparto_estado` (`sin_reparto`/`en_curso`/`cerrado`, esta feature) describen dos formas
incompatibles de cerrar el mismo tramo. Invariante: **un tramo con `estado_liquidacion <> 'activo'`
no puede iniciar reparto, y un tramo con `reparto_estado <> 'sin_reparto'` no puede iniciar
liquidación.** La segunda mitad requiere `create or replace function public.iniciar_liquidacion_tramo`
en la migración `0022`, copiando su cuerpo actual (migración `0018`) y añadiendo solo el chequeo de
`reparto_estado` con el código `PA032` — coordinado con la autora de esa spec.
