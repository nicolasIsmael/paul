# Implementation Plan: Cobro de Facturas, Reparto de Retornos y Reloj de Demo

**Branch**: `20260923-210731-cobro-reparto-retornos` | **Date**: 2026-09-23 (revisado 2026-09-25) | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260923-210731-cobro-reparto-retornos/spec.md`

## Revisión 2026-09-25 (leer primero)

Dos hechos nuevos cambiaron el plan original:

1. **Ruta simple elegida por el equipo (demo el 2026-09-26)**: no se construye el contrato
   `pool_settlement`. La cascada senior/junior se calcula en Postgres y los pagos son pagos
   nativos reales de XLM. Detalle y costo en [research.md](./research.md) §1 y en Complexity
   Tracking (es una desviación **aceptada** del Principio VI).
2. **Existe otra feature ya implementada y aplicada en remoto que cubre el mismo tramo del flujo**:
   [`specs/20260925-002004-liquidacion-tramo`](../20260925-002004-liquidacion-tramo/spec.md)
   (Edge Function `liquidar-tramo`, migraciones `0018`/`0019`, `tramos.estado_liquidacion`, tabla
   `liquidaciones_tramo_inversionista`; paga capital + rendimiento ilustrativo y **quema**
   fracciones). Ver sección "Coexistencia con `liquidacion-tramo`" abajo: hay que evitar el doble
   pago, los choques de nombres/códigos y no romper su flujo.

## Summary

Cierra el ciclo aporte → cobro → reparto con evidencia on-chain real. Tres piezas conectadas:

1. **Cobro simulado del deudor** (`cobrar-factura`, `marcar-factura-mora`): Edge Functions que
   mueven XLM real en testnet desde **una única cuenta de deudor de demo** (fondeada vía
   Friendbot, reutilizada para todas las facturas y pools) hacia la **custodia del pool**, y solo
   con el pago confirmado marcan la factura como `cobrada`. La mora es un cambio de estado sin
   movimiento de dinero.
2. **Reparto por tramo** (`repartir-tramo` + `_shared/reparto-pagos.ts`): cuando todas las
   facturas del pool están en estado final (o el operador lo fuerza), Postgres calcula la cascada
   senior/junior y el prorrateo por inversionista, y cada inversionista recibe **una transacción
   de pago XLM propia** desde la custodia, con estado individual (`pendiente`/`pagado`/`fallido`) y
   reintento solo de lo no pagado. El tramo queda `cerrado` con el 100 % pagado.
3. **Reloj de demo por pool**: cada pool tiene su propio desplazamiento de tiempo
   (`reloj_pool`); las reglas de fecha de un pool (vigencia de cotizaciones y reservas,
   vencimiento de facturas y de pool, fecha efectiva de cobro/reparto) leen `ahora_pool(pool_id)`
   en vez de `now()`. Adelantar el reloj de un pool nunca afecta a otro.

Sigue siendo **solo backend/API** — sin pantallas y sin cambios al contrato Soroban existente.

## Technical Context

**Language/Version**: SQL/PL-pgSQL (Postgres 17) para migraciones y RPC; TypeScript/Deno para las
Edge Functions. **Sin código Rust nuevo** (no hay contrato nuevo).

**Primary Dependencies**: `@stellar/stellar-sdk@^17` (ya en uso: `Horizon.Server`,
`TransactionBuilder`, `Operation.payment`, `Operation.accountMerge`); Friendbot de testnet (nuevo
uso: fondeo de la cuenta deudor); Supabase Vault (secreto de la cuenta deudor, mismo patrón que
`tesoreria_stellar_demo`); `lock_firma_stellar` (0016) para serializar firmas. **Sin dependencias
nuevas** en `package.json`.

**Storage**: Supabase Postgres — 7 tablas nuevas (`reloj_pool`, `reloj_pool_avances`,
`cuenta_deudor_demo`, `cobros_factura`, `liquidaciones_pool`, `repartos_tramo`, `pagos_reparto`),
2 tablas existentes ampliadas (`facturas`, `tramos`). Stellar testnet: pagos nativos
(deudor → custodia y custodia → inversionistas); el contrato `pool_fraction_token` **solo se lee**
(`total_supply`) para verificar coherencia — no se invoca ninguna función de escritura.

**Testing**: sin tests automatizados (Principio I; ya no hay contrato nuevo, así que tampoco
aplica la excepción de `cargo test`). Validación manual con [quickstart.md](./quickstart.md):
cobro real, cascada con mora, forzado, fallo parcial con reintento, ráfaga concurrente y dos pools
con relojes distintos.

**Target Platform**: Supabase (Postgres + Edge Functions Deno) + Stellar testnet (Horizon,
Soroban RPC solo lectura, Friendbot).

**Project Type**: backend-only sobre el monorepo existente (`/supabase`); no toca `/apps/*` ni
`/contracts`.

**Performance Goals**: cobro individual < 15 s; reparto de un tramo ≈ N × 6 s por inversionista,
por lotes acotados por invocación (research §7); ciclo de demo < 3 min con 2-4 inversionistas.

**Constraints**: una sola transacción "en vuelo" por cuenta firmante → toda firma con la cuenta
deudor o una custodia pasa por `conLockFirma`; Friendbot entrega ~10 000 XLM por cuenta (research
§4); nada fuera de Vault; todo cambio de esquema/función como archivo versionado (Principio VII);
**no editar migraciones ya aplicadas** (`0001`–`0019`); códigos de error propios desde `PA030`.

**Scale/Scope**: demo — 6 pools, 29 facturas, ~4 perfiles, hasta ~10 inversionistas por tramo.

## Constitution Check

*GATE: debe pasar antes de Phase 0. Re-evaluado tras Phase 1 (abajo).*

| Principio | Evaluación |
|-----------|------------|
| **I. Velocidad, sin sacrificar estructura** | ✅ Una migración por pieza (reloj, cobro, reparto, consultas, forzado), 3 Edge Functions delgadas + 3 módulos `_shared/`. Ningún archivo pensado para superar ~250 líneas. Sin tests (ya no hay contrato nuevo). |
| **II. Stack flexible** | ✅ Sin cambios de stack. |
| **III. Arquitectura pragmática entre apps** | ✅ No toca `/apps/*`. |
| **IV. Un solo modelo de datos genérico** | ✅ Nada ramifica por tipo de activo. |
| **V. Enfoque en el caso de uso principal** | ✅ Es el tramo "pago → distribución" del flujo de 3 minutos. Recortado: sin burn, sin secundario, sin UI, sin contrato nuevo. |
| **VI. Evidencia on-chain real (NON-NEGOTIABLE)** | ⚠️ **Desviación aceptada por el equipo** (ver Complexity Tracking). Todo movimiento de dinero es una transacción real verificable en Horizon (cobro y cada pago) y las fracciones siguen siendo on-chain, pero la **cascada senior/junior y la irreversibilidad viven en Postgres**, no en un contrato. Se documenta sin presentarla como on-chain. |
| **VII. Infraestructura Supabase versionada** | ✅ Migraciones `0020`–`0026` en `/supabase/migrations`, funciones en `/supabase/functions`, `verify_jwt` en `supabase/config.toml`. Nada solo en el dashboard. |

**Resultado**: pasa con una desviación consciente y documentada del Principio VI.

## Coexistencia con `liquidacion-tramo` (spec paralela, ya aplicada en remoto)

Lo que ya existe (no se modifica salvo lo indicado): `tramos.estado_liquidacion`
(`activo → liquidando → liquidado`), tabla `liquidaciones_tramo_inversionista`, RPCs
`iniciar_liquidacion_tramo`, `registrar_pago_liquidacion`, `registrar_liquidacion_compensada`,
`finalizar_liquidacion_tramo`, `obtener_tasa_cambio_liquidacion`, Edge Function `liquidar-tramo`,
y los códigos `PA021` (tramo no activo), `PA022` (facturas sin cobrar), `PA023` (tramo
inexistente). Paga **capital + rendimiento ilustrativo** en XLM y **quema** las fracciones; exige
100 % de facturas `cobrada` (sin mora ni waterfall).

| Tema | Riesgo | Decisión de este plan |
|------|--------|-----------------------|
| **Doble pago del mismo tramo** (ambos pagan desde la misma custodia) | Alto: dinero real pagado dos veces | Exclusión mutua **en ambas direcciones**: `iniciar_reparto_tramo` rechaza (`PA032`) si `tramos.estado_liquidacion <> 'activo'`; y una migración nuestra (`0022`) redefine con `create or replace` `iniciar_liquidacion_tramo` añadiendo solo el rechazo si `tramos.reparto_estado <> 'sin_reparto'`. **Coordinar con la autora antes de aplicar** (tarea `[COORD]`). |
| **Números de migración** | `0018`/`0019` ya ocupados (aplicados en remoto) | Las nuestras son `0020`–`0026`. |
| **Códigos de error** | `PA021`–`PA023` ya significan otra cosa | Los nuestros pasan a `PA030`–`PA039`. |
| **`actualizar_estado_cobro_factura`** (0013) | Su flujo marca `cobrada` con esa función; revocarla (como preveía el plan original) **rompería su demo** | **No se revoca.** Queda como camino manual legado. Consecuencia: una factura puede quedar `cobrada` sin `cobros_factura` on-chain (incumple FR-003 por ese camino). Se registra como deuda para después de la demo. El trigger de guardia solo bloquea transiciones inválidas y el cambio en tramos ya repartidos. |
| **Quema de fracciones** | Su flujo quema; el nuestro no (spec: fuera de alcance) | Mutuamente excluyentes por tramo, así que no hay conflicto de balances; la verificación `total_supply` de nuestro reparto se omite si el tramo ya fue liquidado por su flujo (ya está rechazado por exclusión mutua). |
| **Reglas de negocio distintas** (ilustrativo vs. real; sin mora vs. con mora) | Confusión en la demo sobre cuál usar | **Decisión del equipo pendiente**, fuera de este plan: cuál de los dos flujos se muestra el día de la presentación. Ambos pueden convivir; solo uno puede cerrar un tramo dado. |
| **README** | Ya documenta su módulo | Agregar una sección hermana para este módulo (tarea de cierre). |

## Project Structure

### Documentation (this feature)

```text
specs/20260923-210731-cobro-reparto-retornos/
├── plan.md                              # Este archivo
├── research.md                          # Phase 0 — decisiones y alternativas
├── data-model.md                        # Phase 1 — tablas, estados, funciones de dominio
├── quickstart.md                        # Phase 1 — validación de punta a punta
├── contracts/
│   ├── reloj-pool.md                    # RPC avanzar_reloj_pool / estado_reloj_pool
│   ├── cobrar-factura-function.md       # Edge Function de cobro simulado
│   ├── marcar-factura-mora-function.md  # Edge Function de mora
│   ├── repartir-tramo-function.md       # Edge Function de reparto (auto/forzado/reintento)
│   └── consultas-reparto.md             # RPC de lectura (mis_repartos, estado_reparto_pool…)
├── checklists/requirements.md
└── tasks.md                             # Phase 2 — /speckit-tasks
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   ├── 0020_reloj_pool.sql              # base del reloj: reloj_pool(+avances), ahora_pool/hoy_pool
│   │                                    #   (sin adelanto = reloj real; NO cambia ninguna regla aún)
│   ├── 0021_cobro_facturas.sql          # cuenta_deudor_demo, cobros_factura, tramos.reparto_estado,
│   │                                    #   guardia de estado en facturas, iniciar/confirmar/fallar
│   │                                    #   cobro, mora, RLS de lock_firma_stellar
│   ├── 0022_reparto_tramos.sql          # liquidaciones_pool, repartos_tramo, pagos_reparto, cascada
│   │                                    #   en SQL, exclusión mutua con liquidacion-tramo
│   ├── 0023_consultas_reparto.sql       # mis_repartos, estado_reparto_pool, listar_pagos_reparto
│   ├── 0024_forzar_reparto.sql          # forzar_reparto_pool (Historia 3)
│   ├── 0025_reloj_reglas_pool.sql       # avanzar/estado_reloj_pool; cotizar_aporte/reservar_aporte
│   │                                    #   leen el reloj del pool (Historia 4, opcional para la demo)
│   └── 0026_consultas_extendidas.sql    # detalle_pool/facturas_del_pool/mis_posiciones con fecha
│                                        #   efectiva, vencida y reparto (pulido)
├── functions/
│   ├── cobrar-factura/index.ts          # HTTP → cobro real deudor→custodia → evalúa reparto
│   ├── marcar-factura-mora/index.ts     # HTTP → mora → evalúa reparto
│   ├── repartir-tramo/index.ts          # HTTP → forzar / reintentar reparto de un tramo
│   └── _shared/
│       ├── stellar-payment.ts           # (existente) + memo opcional, Friendbot, accountMerge
│       ├── cuenta-deudor.ts             # provisión idempotente + reposición por fusión Friendbot
│       └── reparto-pagos.ts             # orquestación: liquidar (SQL) → crear pagos → pagar → cerrar
└── config.toml                          # + [functions.cobrar-factura|marcar-factura-mora|repartir-tramo]
```

**Datos de demo**: no hay seed SQL. Los aportes y las facturas de demo deben crearse con las funciones reales (`registrar_factura` → `asignar-factura` → `recargar-wallet` → `confirmar-aporte`) para que las fracciones on-chain coincidan con Postgres (lección de `liquidacion-tramo`: un seed con hashes falsos desincronizó un pool). Ver `quickstart.md` §0.

**Structure Decision**: se extiende la estructura backend existente. Ningún archivo de
`liquidacion-tramo` ni migración aplicada se edita; la única intervención sobre su código es una
redefinición aditiva (`create or replace`) en una migración nuestra, coordinada. `/contracts` no se
toca.

## Complexity Tracking

| Violación / complejidad | Por qué se acepta | Alternativa rechazada |
|-------------------------|-------------------|------------------------|
| **Desviación del Principio VI**: cascada senior/junior e irreversibilidad del reparto en Postgres | La demo es el 2026-09-26; un contrato nuevo (código Rust, pruebas, despliegue y cableado de 3 funciones) es el mayor riesgo de plazo. Los cobros y los pagos son transacciones nativas reales verificables en Horizon y las fracciones siguen on-chain, que es lo que sostiene la narrativa "dinero real que vuelve al inversionista". | Contrato `pool_settlement` que calcule la cascada y bloquee liquidar/cerrar dos veces (diseño completo en el historial de este plan, descartado por tiempo). **Riesgo residual**: el resultado de la cascada no es verificable on-chain; en la presentación debe describirse como "cálculo de la plataforma", nunca como lógica on-chain. Recomendado como trabajo posterior a la demo o enmienda de la constitución. |
| 7 tablas nuevas | Cada una modela un hecho distinto con estado propio (cobro, liquidación del pool, reparto del tramo, pago individual, reloj y su historial, cuenta deudor). | Columnas sueltas en `facturas`/`tramos` mezclarían ciclos de vida y no darían el estado por inversionista que exige el reintento. |
| Redefinir `iniciar_liquidacion_tramo` (código de otra spec) | Única forma de garantizar en la base de datos que un tramo no se pague dos veces por dos mecanismos distintos. | Confiar en que el operador no ejecute ambos: no es una garantía. |

## Constitution Check (post-diseño)

Re-evaluado tras `research.md`, `data-model.md` y `contracts/`: sin cambios respecto al chequeo
inicial. La única desviación (VI) está registrada arriba. VII queda cubierto: migraciones, funciones
y seed tienen ruta fija en el árbol; el quickstart exige `git status` limpio tras cada despliegue.
