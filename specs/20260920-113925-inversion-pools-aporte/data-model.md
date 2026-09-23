# Data Model: Exploración de Pools y Primer Aporte del Inversionista

Convención de dinero (spec > Restricciones y Assumptions): **nunca `float`/`double precision`**,
solo `numeric`. Montos en soles/dólares: `numeric(14,2)`. Montos en XLM: `numeric(20,7)` (XLM
tiene 7 decimales — 1 stroop = 0.0000001 XLM). Tipo de cambio: `numeric(18,7)`, definido siempre
como **"cuántas unidades de la moneda equivalen a 1 XLM"** (`monto_moneda = monto_xlm * tasa`,
`monto_xlm = monto_moneda / tasa`) — convención única para evitar confusión de dirección en todo
el código.

**Acceso**: ninguna de las tablas nuevas de esta feature concede `SELECT`/`INSERT`/`UPDATE` a
`anon`/`authenticated` — todo el acceso de cliente pasa por las funciones `security definer`
descritas en `contracts/`. Esto reutiliza y refuerza el hallazgo de `research.md` de la feature
previa (Supabase concede privilegios de tabla completa por defecto a `authenticated` en tablas
nuevas de `public` — hay que revocarlos explícitamente en cada tabla nueva, no asumir que "no
conceder" es suficiente) y además resuelve de raíz el requisito de la spec de que el inversionista
nunca vea facturas ni empresas individuales (FR-014 de esta spec): simplemente no existe ninguna
vía PostgREST para leer `operaciones`/`empresas_pagadoras` fila por fila.

## Registro de códigos de error estables

Todas las funciones de esta feature señalan fallos de negocio con
`raise exception using errcode = '<código>', message = '<mensaje>'`, nunca con un mensaje genérico
sin código. PostgREST expone `errcode` como `error.code` y `message` como `error.message` en la
respuesta HTTP (400). Los mismos códigos los usa la Edge Function `confirmar-aporte` en su propio
cuerpo de respuesta JSON para los fallos que detecta fuera de la base de datos (pago Stellar).

| Código | Significado | Caso límite de la spec |
|---|---|---|
| `PA001` | Monto no es múltiplo de la unidad mínima del pool | Edge case, FR-021 |
| `PA002` | Saldo de demostración insuficiente (en la moneda del pool) | Historia 4 escenario 3, FR-022 |
| `PA003` | Monto excede el cupo disponible del tramo | Historia 4 escenario 5, FR-023 |
| `PA004` | Cotización expirada | Historia 4 escenario 6, FR-025 |
| `PA005` | Cotización inválida, ya usada, o de otro inversionista | Doble envío / reintento, FR-027 |
| `PA006` | Pool o tramo ya no está "abierto" | Historia 4 escenarios 7 y 12→pool cerrado, FR-028 |
| `PA007` | Billetera del inversionista todavía se está creando | Historia 4 escenario 10, FR-007/FR-029 |
| `PA008` | Rol no autorizado (cuenta operador de banco) | Historia 4 escenario 11, FR-030 |
| `PA009` | XLM insuficiente en la billetera (pago + reserva de 2 XLM) | Historia 4 escenario 12, FR-031 |
| `PA010` | Tipo de cambio de referencia no disponible | Edge case, FR-020 |
| `PA011` | Tope diario de recarga excedido | Historia 3 escenario 3, FR-005 |
| `PA012` | Pool o tramo inexistente | Entrada inválida genérica |
| `PA013` | Fallo de red al someter el pago a Stellar testnet | research.md §3 (timeout de Horizon) |

## Entidades

### `public.empresas_pagadoras`

Ficticia, agregada únicamente (nunca expuesta individualmente al inversionista — FR-014).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | `default gen_random_uuid()` |
| `nombre_comercial` | text NOT NULL | ficticio, sin marcas reales |
| `sector` | `public.sector_empresa` (enum) NOT NULL | `retail`, `manufactura`, `servicios`, `construccion`, `tecnologia` |
| `created_at` | timestamptz NOT NULL default `now()` | |

### `public.operaciones`

La "factura fraccionable" de confirming. Solo se crea vía seed en esta feature (el flujo de
aprobación del operador está fuera de alcance — se cargan como si ya estuvieran aprobadas).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `pool_id` | uuid NOT NULL, FK → `pools.id` | una operación pertenece a un solo pool |
| `empresa_id` | uuid NOT NULL, FK → `empresas_pagadoras.id` | |
| `moneda` | `public.moneda_soportada` (enum: `PEN`, `USD`) NOT NULL | **debe** coincidir con `pools.moneda` (trigger de validación, no solo confianza en el seed) |
| `monto_nominal` | numeric(14,2) NOT NULL, check > 0 | valor que esta operación aporta a la composición agregada del pool |
| `created_at` | timestamptz NOT NULL default `now()` | |

**Trigger `operaciones_moneda_coincide_pool`**: `before insert or update`, rechaza si
`new.moneda <> (select moneda from pools where id = new.pool_id)` — refuerza FR-039 (pool = una
sola moneda) a nivel de dato, no solo de disciplina del seed.

### `public.pools`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `codigo` | text NOT NULL, unique | identificador corto legible (`"POOL-PEN-001"`), usado por el seed para ser idempotente (`on conflict (codigo) do nothing`) |
| `nombre` | text NOT NULL | |
| `descripcion_corta` | text NOT NULL | lenguaje simple, FR-013 |
| `moneda` | `public.moneda_soportada` NOT NULL | |
| `plazo_dias` | integer NOT NULL, check in (30, 60, 90) | |
| `perfil_riesgo` | `public.perfil_riesgo_pool` (enum: `conservador`, `balanceado`, `agresivo`) NOT NULL | |
| `perfil_riesgo_explicacion` | text NOT NULL | 1-2 frases, FR-013 |
| `fecha_apertura` | timestamptz NOT NULL default `now()` | |
| `fecha_vencimiento_esperada` | date NOT NULL | |
| `estado` | `public.estado_pool` (enum: `abierto`, `fondeado`, `cerrado`) NOT NULL default `abierto` | ver máquina de estados abajo |
| `unidad_minima_aporte` | numeric(14,2) NOT NULL, check > 0 | referencia: S/100 o US$25 |
| `custody_public_key` | text | dirección pública Stellar de la cuenta de custodia del pool; NULL hasta que el aprovisionamiento asíncrono termine (idéntico ciclo de vida al de `perfiles.wallet_public_key` en la feature previa) |
| `custody_secret_id` | uuid | referencia a `vault.secrets.id`; nunca expuesto vía API pública, mismo tratamiento que `perfiles.wallet_secret_id` |
| `created_at` / `updated_at` | timestamptz | |

**Máquina de estados** (Clarifications de `spec.md`):
- `abierto → fondeado`: automático, disparado por trigger cuando **ambos** tramos alcanzan
  `capital_comprometido = capital_objetivo` (ver trigger en `tramos`, abajo).
- `abierto → cerrado`: manual, por el operador de banco (fuera de alcance — se aplica solo vía
  seed/`UPDATE` directo en esta feature, nunca vía una función de cliente).
- `fondeado`/`cerrado` son terminales: ninguna función de aporte los revierte a `abierto`.

**Capital objetivo / comprometido a nivel de pool**: no se duplica en `pools` — se calcula siempre
sumando los dos `tramos` (fuente única de verdad, ver `catalogo_pools`/`detalle_pool` en
`contracts/`). Evita el problema clásico de desincronización de un total denormalizado.

### `public.tramos`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `pool_id` | uuid NOT NULL, FK → `pools.id` | |
| `tipo` | `public.tipo_tramo` (enum: `senior`, `junior`) NOT NULL | |
| `capital_objetivo` | numeric(14,2) NOT NULL, check > 0 | |
| `capital_comprometido` | numeric(14,2) NOT NULL default 0, check >= 0 **and** `capital_comprometido <= capital_objetivo` | el `check` es defensa en profundidad; la garantía real de concurrencia la da el `UPDATE` condicional (research.md §1) |
| `rendimiento_ilustrativo_plazo_pct` | numeric(6,3) NOT NULL | % ilustrativo para el plazo del pool |
| `rendimiento_ilustrativo_anualizado_pct` | numeric(6,3) NOT NULL | mismo dato, expresado anualizado (FR-015) |
| `created_at` / `updated_at` | timestamptz | |

`unique (pool_id, tipo)` — exactamente un tramo senior y uno junior por pool.

**Colchón de pérdida del junior** (FR-016): no es una columna — se deriva en
`detalle_pool` como `tramo_junior.capital_objetivo / (tramo_senior.capital_objetivo +
tramo_junior.capital_objetivo) * 100`, consistente con su definición de negocio ("qué % del pool
absorbe pérdidas antes de tocar al senior").

**Trigger `tramos_actualiza_estado_pool`** (`after update of capital_comprometido`): si, tras el
`UPDATE`, ambos tramos del pool tienen `capital_comprometido = capital_objetivo` **y**
`pools.estado = 'abierto'`, actualiza `pools.estado = 'fondeado'`. Es la única vía de la
transición automática `abierto → fondeado`.

### `public.tipos_cambio_referencia`

Histórico append-only (nunca se hace `UPDATE` de una fila existente) — permite que cada cotización
guarde la tasa exacta que se usó sin depender de que la tasa "vigente" no cambie después.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `moneda` | `public.moneda_soportada` NOT NULL | |
| `tasa_moneda_por_xlm` | numeric(18,7) NOT NULL, check > 0 | ver convención de dirección arriba |
| `vigente_desde` | timestamptz NOT NULL default `now()` | |
| `nota` | text | rotula explícitamente que es un parámetro de demostración (FR-037), p. ej. `'Parámetro de demostración — testnet, sin valor de mercado real'` |

Función `tipo_cambio_vigente(p_moneda)` devuelve la fila con `vigente_desde` más reciente para esa
moneda, o `NULL` si no hay ninguna (edge case: tipo de cambio no disponible → `PA010`).

### `public.saldos_demostracion`

| Campo | Tipo | Notas |
|---|---|---|
| `investor_id` | uuid NOT NULL, FK → `auth.users.id` on delete cascade | |
| `moneda` | `public.moneda_soportada` NOT NULL | |
| `saldo` | numeric(14,2) NOT NULL default 0, check >= 0 | |
| `updated_at` | timestamptz NOT NULL default `now()` | |

`primary key (investor_id, moneda)` — como máximo una fila por inversionista y moneda (soles
y/o dólares son sub-saldos independientes, FR-001).

### `public.recargas_saldo`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `investor_id` | uuid NOT NULL, FK → `auth.users.id` | |
| `moneda` | `public.moneda_soportada` NOT NULL | |
| `monto` | numeric(14,2) NOT NULL, check > 0 | |
| `monto_equivalente_soles` | numeric(14,2) NOT NULL | precomputado al momento de la recarga, usado para sumar el tope diario compartido entre monedas sin tener que volver a convertir en cada consulta |
| `tipo_cambio_referencia_aplicado` | numeric(18,7) | solo relevante si `moneda <> 'PEN'`; `NULL` si `moneda = 'PEN'` (no hace falta convertir) |
| `created_at` | timestamptz NOT NULL default `now()` | |

Índice `idx_recargas_saldo_investor_dia` en `(investor_id, (( created_at at time zone
'America/Lima')::date))` — soporta la consulta del tope diario (FR-004/FR-005) sin escanear toda
la tabla.

### `public.cotizaciones`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `investor_id` | uuid NOT NULL, FK → `auth.users.id` | dueño de la cotización; `reservar_aporte` valida que coincide con el inversionista que confirma |
| `pool_id` | uuid NOT NULL, FK → `pools.id` | |
| `tramo_id` | uuid NOT NULL, FK → `tramos.id` | |
| `monto_nominal` | numeric(14,2) NOT NULL, check > 0 | en la moneda del pool |
| `moneda` | `public.moneda_soportada` NOT NULL | copia de `pools.moneda` al momento de cotizar (histórico, aunque el pool nunca cambia de moneda) |
| `tipo_cambio_aplicado` | numeric(18,7) NOT NULL | tasa usada, copiada de `tipos_cambio_referencia` en ese instante |
| `monto_xlm` | numeric(20,7) NOT NULL | `monto_nominal / tipo_cambio_aplicado` |
| `generado_at` | timestamptz NOT NULL default `now()` | |
| `expira_at` | timestamptz NOT NULL default `now() + interval '5 minutes'` | validez fija de 5 minutos (Clarifications) |
| `usada` | boolean NOT NULL default `false` | se marca `true` al crear una reserva a partir de ella — impide reutilizar la misma cotización dos veces (`PA005`) |

### `public.aportes`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `investor_id` | uuid NOT NULL, FK → `auth.users.id` | |
| `pool_id` | uuid NOT NULL, FK → `pools.id` | |
| `tramo_id` | uuid NOT NULL, FK → `tramos.id` | |
| `cotizacion_id` | uuid NOT NULL, FK → `cotizaciones.id` | |
| `idempotency_key` | uuid NOT NULL | provista por el cliente en cada intento de confirmación |
| `monto_nominal` | numeric(14,2) NOT NULL | copiado de la cotización al reservar |
| `moneda` | `public.moneda_soportada` NOT NULL | |
| `tipo_cambio_aplicado` | numeric(18,7) NOT NULL | copiado de la cotización — es el que se aplica, nunca se recalcula (FR-024) |
| `xlm_pagados` | numeric(20,7) | `NULL` hasta `confirmado`; igual a `cotizaciones.monto_xlm` cuando se confirma |
| `estado` | `public.estado_aporte` (enum: `reservado`, `confirmado`, `revertido`) NOT NULL default `reservado` | |
| `tx_hash` | text | hash de la transacción Stellar testnet; `NULL` si `comprobante_simulado = true` |
| `comprobante_simulado` | boolean NOT NULL default `false` | rotula explícitamente cuando se usó el comprobante de respaldo (FR-033) |
| `motivo_reversion` | `public.motivo_reversion_aporte` (enum: `xlm_insuficiente`, `fallo_red_stellar`, `reserva_vencida`, `otro`) | solo si `estado = 'revertido'` |
| `reservado_at` | timestamptz NOT NULL default `now()` | |
| `expira_reserva_at` | timestamptz NOT NULL default `now() + interval '2 minutes'` | ventana máxima que una reserva puede quedar `reservado` antes de liberarse sola (ver ciclo de vida) |
| `confirmado_at` / `revertido_at` | timestamptz | |

`unique (investor_id, idempotency_key)` — es la garantía de "no duplica el aporte" a nivel de
base de datos (Historia 4 escenario 8), no solo de disciplina del cliente.

## Relaciones

```
auth.users (1) ──┬── (0..*) public.saldos_demostracion (por moneda)
                  ├── (0..*) public.recargas_saldo
                  ├── (0..*) public.cotizaciones
                  └── (0..*) public.aportes ──── (1) public.cotizaciones (1:1 lógico: cada aporte nace de una cotización, cada cotización se usa en, a lo sumo, un aporte)

public.pools (1) ──┬── (2) public.tramos (exactamente senior + junior)
                    ├── (0..*) public.operaciones ──── (1) public.empresas_pagadoras
                    ├── (0..*) public.cotizaciones
                    └── (0..*) public.aportes

public.tramos (1) ──── (0..*) public.cotizaciones / public.aportes
```

## Ciclo de vida / transiciones de estado

### Pool

`abierto → fondeado` (automático, trigger sobre `tramos`) | `abierto → cerrado` (manual, fuera de
alcance del cliente). Ambos terminales.

### Aporte (el más importante — ver FR-032/FR-034 y research.md §1)

```
                    reservar_aporte()                 pago XLM ok → confirmar_aporte()
   (no existe) ───────────────────────► reservado ───────────────────────────────────► confirmado
                cupo + saldo demo                                                       (terminal)
                descontados atómicamente          pago falla / XLM insuficiente /
                en la MISMA transacción           timeout Horizon → revertir_aporte()
                                        │
                                        └───────────────────────────────────────────► revertido
                                             (libera cupo del tramo y devuelve el       (terminal)
                                              saldo de demostración descontado)

   reserva con expira_reserva_at < now() y estado='reservado' todavía
   (p. ej. la Edge Function murió a mitad de la orquestación, nunca llamó
   confirmar_aporte ni revertir_aporte) ──► la siguiente llamada a reservar_aporte()
                                             o cotizar_aporte() la barre primero
                                             (UPDATE ... SET estado='revertido',
                                             motivo_reversion='reserva_vencida' WHERE
                                             estado='reservado' AND expira_reserva_at < now(),
                                             liberando su cupo y su saldo demo) antes de
                                             procesar la solicitud nueva — sin necesitar
                                             pg_cron ni ningún proceso en segundo plano.
```

**Por qué el cupo se descuenta en `reservado`, no en `confirmado`**: si se descontara solo al
confirmar, dos reservas concurrentes podrían pasar ambas la validación de cupo (porque ninguna lo
había comprometido todavía) y luego las dos intentar pagar — exactamente la condición de carrera
que SC-002/FR-026 prohíben. Al comprometer el cupo de forma atómica en el mismo `UPDATE` que crea
la reserva, la segunda solicitud que ya no cabe se rechaza **antes** de tocar la red Stellar.

### Cotización

`generada` (usada=false) → `usada=true` (al reservar) **o** simplemente expira sin usarse
(`expira_at` pasado) → cualquier intento posterior de reservar con ella falla con `PA004`/`PA005`.

## Índices

- `tramos (pool_id)`, `operaciones (pool_id)`, `operaciones (empresa_id)` — joins de agregación en
  `detalle_pool`.
- `cotizaciones (investor_id, expira_at)` — limpieza/validación de vigencia.
- `aportes (investor_id, estado)` — `mis_posiciones()` filtra por dueño y, para liberar reservas
  vencidas, por `estado`.
- `aportes (estado, expira_reserva_at) where estado = 'reservado'` (índice parcial) — la barrida
  de reservas vencidas solo escanea reservas activas, nunca la tabla completa.
- `recargas_saldo (investor_id, ((created_at at time zone 'America/Lima')::date))` — ya descrito
  arriba.

## RLS y privilegios — resumen

| Tabla | RLS habilitada | Políticas | Grants a `anon`/`authenticated` |
|---|---|---|---|
| `empresas_pagadoras`, `operaciones`, `pools`, `tramos` | Sí, sin políticas (deny-all por defecto) | ninguna | **ninguno** — solo accesibles vía `catalogo_pools`/`detalle_pool` (`security definer`) |
| `tipos_cambio_referencia` | Sí, sin políticas | ninguna | **ninguno** — solo vía `tipo_cambio_vigente()`, usada internamente por otras funciones |
| `saldos_demostracion`, `recargas_saldo`, `cotizaciones`, `aportes` | Sí, sin políticas | ninguna | **ninguno** — acceso vía `mi_saldo_demostracion`, `cotizar_aporte`, `mis_posiciones` y funciones internas de `service_role`; la recarga entra por `recargar-wallet` |

Las funciones de cliente (`catalogo_pools`, `detalle_pool`, `mi_saldo_demostracion`,
`cotizar_aporte`, `mis_posiciones`) son `security definer` con
`set search_path = ''`, `execute` revocado explícitamente de `public, anon, authenticated` y
vuelto a conceder **solo** a `authenticated` — nunca a `anon` (todo este flujo requiere sesión).
Cada una valida `auth.uid()` y el rol (`perfiles.rol = 'inversionista'`) en su propio cuerpo antes
de tocar cualquier tabla (defensa en profundidad, igual que exige la spec).

`recargar_saldo_demo` queda revocada para clientes desde `0017_recargas_stellar.sql`; la Edge
Function `recargar-wallet` usa las operaciones internas idempotentes de recarga con `service_role`.

Las funciones internas (`reservar_aporte`, `confirmar_aporte`, `revertir_aporte`,
`obtener_secreto_wallet`, `aprovisionar_custodia_pool`, `obtener_url_base_functions`) tienen
`execute` revocado de `public, anon, authenticated` y concedido **solo** a `service_role` — nunca
invocables vía `/rest/v1/rpc/...` por un cliente, solo desde la Edge Function `confirmar-aporte` o
desde el trigger de aprovisionamiento correspondiente.

## Fuera de este modelo

- Vencimiento, cobro y reparto de retornos de un pool: no hay tabla ni estado para ello en esta
  feature (fuera de alcance de la spec).
- Retiro anticipado de un aporte: no hay transición `confirmado → *` que lo permita.
- Aprobación de operaciones por el operador de banco: `operaciones`/`empresas_pagadoras`/`pools`
  se cargan ya "aprobados" vía seed; no existe ningún estado de aprobación pendiente en esta
  feature.
