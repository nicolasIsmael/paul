# Implementation Plan: Liquidación de Tramo (Cobro Simulado, Camino Feliz)

**Branch**: `20260925-002004-liquidacion-tramo` | **Date**: 2026-09-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260925-002004-liquidacion-tramo/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Cierra la mitad del ciclo de inversión que hoy no existe: "el inversionista aporta y recibe
fracciones" (ya construido) sin ningún camino de vuelta ("el inversionista cobra su capital + su
rendimiento"). Este plan agrega una liquidación **por tramo completo** (nunca por factura
individual): el operador de banco, una vez que el 100% de las facturas asignadas a un tramo ya
están en `estado_cobro='cobrada'`, dispara la liquidación. Para cada inversionista con fracciones
reales verificadas on-chain en ese tramo, el sistema paga capital + rendimiento ilustrativo en XLM
real (custodia → inversionista) y quema esas fracciones en el contrato, firmando con la propia
llave del inversionista (ya custodiada en Vault, mismo patrón que la llave admin). Un fallo
puntual en un inversionista se compensa solo a esa persona; el resto del tramo se sigue procesando.
Mora, pago parcial y el reparto real de pérdidas entre tramo senior/junior (waterfall) quedan fuera
de alcance a propósito. **No se construye ningún frontend en este plan** — sigue siendo capacidad
de backend/contrato, igual que las 3 features previas.

## Technical Context

**Language/Version**: SQL/PL-pgSQL para la migración y las funciones RPC de Postgres 17 (igual que
las features previas); TypeScript/Deno para la Edge Function nueva (mismo runtime ya en uso). Sin
cambios al contrato Soroban existente — `burn` ya existe en `contracts/soroban-pool/src/lib.rs` y
no necesita modificarse.

**Primary Dependencies**: ninguna dependencia nueva. Se reutilizan tal cual
`@stellar/stellar-sdk@^17`, `invocarContratoAdmin`/`invocarContratoAdminConReintentos` y
`consultarSoloLectura` (`supabase/functions/_shared/stellar-soroban.ts`), `pagarXlm`
(`_shared/stellar-payment.ts`), y `conLockFirma` (`_shared/lock-firma.ts`, ya generalizado por
cuenta firmante — sirve igual para la cuenta del inversionista que para la del admin).

**Storage**: Supabase Postgres — 1 migración nueva: una columna de estado terminal en `tramos`
(`estado_liquidacion`) y 1 tabla nueva (`liquidaciones_tramo_inversionista`) para el detalle por
persona de cada liquidación. **No se toca** `facturas.estado_cobro` (FR-023 de la spec previa) ni
ninguna migración ya aplicada. Stellar testnet sigue siendo la fuente de verdad de fracciones —
esta feature **lee** `balance()` del contrato de cada tramo antes de pagar (nunca confía en un
cálculo derivado solo de `aportes`), y ejecuta `burn()` como escritura real.

**Testing**: Sin tests automatizados (Principio I, igual que las features previas — esta feature no
toca el contrato Soroban, así que ni siquiera aplica la única excepción ya establecida de
`cargo test`). Validación manual guiada por `quickstart.md`, incluida una prueba de liquidación con
inversionistas reales, una de tramo sin aportes, y una de fallo forzado de un inversionista
particular con verificación de que el resto del tramo se liquida igual.

**Target Platform**: Supabase Cloud (mismo proyecto) + Stellar testnet — sin componentes de
infraestructura nuevos.

**Project Type**: servicio de backend/API — misma estructura de `supabase/`, sin tocar
`contracts/`.

**Performance Goals**: sin metas nuevas de throughput. Cada llamada a `burn` hereda el mismo
presupuesto interno ya establecido para invocaciones a Soroban (~45s con reintentos,
`research.md` de la spec de originación §2); una liquidación de tramo con N inversionistas procesa
a cada uno de forma secuencial e independiente (un fallo no bloquea a los demás), así que el tiempo
total escala linealmente con N — aceptable para la escala de demo (decenas de inversionistas por
tramo, no miles).

**Constraints**: el monto a pagar se calcula siempre sobre fracciones **reales verificadas
on-chain** (`balance()`), nunca sobre un valor derivado únicamente de `aportes` en Postgres
(Principio VI); el rendimiento aplicado es siempre el ya sembrado en el tramo
(`rendimiento_ilustrativo_plazo_pct`) — esta feature no calcula ni inventa una fórmula financiera
nueva; una liquidación nunca es todo-o-nada para el tramo — cada inversionista se procesa y, si
falla, se compensa de forma independiente.

**Scale/Scope**: 1 migración, 1 Edge Function nueva, cero cambios al contrato — la pieza de menor
riesgo técnico construida hasta ahora en el proyecto, porque reutiliza casi todo lo que ya existe.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación |
|---|---|
| I. Velocidad sobre perfección, sin sacrificar estructura básica | **PASS**. Una sola migración con una sola responsabilidad (estado de liquidación + su detalle), una sola Edge Function nueva y acotada (`liquidar-tramo`). No se reescribe ninguna función existente, solo se reutilizan. |
| II. Stack flexible | **N/A** — no se introduce ni se cambia ninguna herramienta del stack. |
| III. Arquitectura pragmática entre apps | **N/A** — sigue sin construirse ningún frontend en este plan. |
| IV. Un solo modelo de datos genérico | **PASS**. Sigue siendo el mismo activo fraccionable de siempre; esta feature solo le agrega el evento de cierre de su ciclo de vida, sin introducir un segundo tipo de activo ni una ramificación de flujos. |
| V. Enfoque en confirming con pool y tranches | **PASS, y es el motivo de este plan**. El flujo de demo de la constitución exige mostrar "emisión → fraccionamiento → compra → pago → **distribución**" — la distribución (el pago de vuelta al inversionista) es justamente la pieza que faltaba y que este plan agrega. |
| VI. Evidencia on-chain real, no simulada (NON-NEGOTIABLE) | **PASS, es el corazón del plan**. El pago se calcula sobre `balance()` real del contrato (no un número de Postgres) y la quema es una escritura real (`burn`) firmada por el propio inversionista — nada de esto se simula del lado del backend. |
| VII. Infraestructura de Supabase versionada (NON-NEGOTIABLE) | **PASS**. La columna nueva, la tabla nueva y la Edge Function nueva viven en `supabase/migrations/0018_...sql` y `supabase/functions/liquidar-tramo/`, nunca aplicadas desde el dashboard. |

Sin violaciones → no se requiere Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260925-002004-liquidacion-tramo/
├── plan.md                              # This file
├── research.md                          # Phase 0 output
├── data-model.md                        # Phase 1 output
├── quickstart.md                        # Phase 1 output
├── contracts/                           # Phase 1 output
│   ├── liquidar-tramo-function.md       # Edge Function liquidar-tramo (orquestación completa)
│   └── liquidacion-rpcs.md              # Las 4 funciones RPC nuevas de Postgres
└── tasks.md                             # Phase 2 output (/speckit-tasks — NOT created by this plan)
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   └── 0018_liquidacion_tramo.sql       # tramos.estado_liquidacion (activo/liquidando/liquidado,
│                                          # default 'activo'); tabla nueva
│                                          # liquidaciones_tramo_inversionista (tramo_id,
│                                          # investor_id, fracciones, monto_pagado, moneda,
│                                          # tx_hash_pago, tx_hash_quema, estado
│                                          # pagado/compensado, created_at); RPCs
│                                          # iniciar_liquidacion_tramo, registrar_pago_liquidacion,
│                                          # registrar_liquidacion_compensada,
│                                          # finalizar_liquidacion_tramo
└── functions/
    └── liquidar-tramo/index.ts          # nueva — reutiliza consultarSoloLectura, pagarXlm,
                                           # invocarContratoAdminConReintentos (firmando con el
                                           # secreto del inversionista, no del admin) tal cual ya
                                           # existen en _shared/
```

**Structure Decision**: ningún archivo existente se modifica — ni las migraciones previas, ni
`confirmar-aporte`, ni `_shared/stellar-soroban.ts` o `_shared/stellar-payment.ts`. Todo lo nuevo
vive en un solo archivo de migración y una sola Edge Function, siguiendo el mismo patrón de
"nunca editar lo ya aplicado" ya establecido en el proyecto (precedente:
`0004_config_edge_functions_url.sql` sobre `0002_wallet_provisioning.sql`).

## Orden de implementación recomendado

1. **`0018_liquidacion_tramo.sql`** — columna de estado + tabla de detalle + las 4 RPCs. Es la base
   de todo lo demás; se puede probar de forma aislada con datos de ejemplo antes de tocar la Edge
   Function.
2. **`liquidar-tramo/index.ts`** — depende del paso 1. Reutiliza helpers ya existentes; el único
   código genuinamente nuevo es el bucle por inversionista (leer `balance()`, pagar, quemar,
   compensar si falla) y el cálculo del monto (FR-005).
3. Validación de punta a punta con `quickstart.md` contra un tramo real con aportes confirmados
   (ej. Manufactura Sur, tramo senior) — incluye forzar el fallo de un inversionista para probar
   que la compensación individual funciona sin bloquear al resto del tramo.

## Riesgos técnicos y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Calcular el pago sobre `aportes` de Postgres en vez de `balance()` real on-chain, por comodidad | Alto — violaría el Principio VI y podría pagar de más/de menos si hay una inconsistencia previa (como la ya vivida con Retail Norte) | FR-004 lo exige explícitamente; `quickstart.md` debe incluir un paso que compare ambos valores y documente la fuente de verdad usada |
| Firmar `burn` con el secreto del inversionista reutilizando `invocarContratoAdmin` tal cual, sin ajustar el `conLockFirma` por cuenta | Bajo — `conLockFirma` ya está keyeado por `keypair.publicKey()`, así que cada inversionista tiene su propio lock automáticamente, sin cambios de código | Confirmar en `quickstart.md` con una prueba de 2+ inversionistas liquidándose en la misma corrida, verificando que no chocan entre sí (mismo tipo de prueba que ya validó el fix de concurrencia de `0016_lock_firma_stellar.sql`) |
| Un inversionista con aporte confirmado en Postgres pero `balance()` real en 0 (inconsistencia heredada) | Bajo — ya identificado como edge case en la spec | El bucle simplemente no genera pago para esa persona (fracciones reales = 0 → monto = 0); se registra igual en `liquidaciones_tramo_inversionista` con `fracciones=0` para dejar evidencia de que se revisó |
| Liquidación interrumpida a la mitad (ej. la Edge Function se cae después de procesar a algunos inversionistas) | Medio | El tramo queda en `liquidando` (no `liquidado`) hasta que `finalizar_liquidacion_tramo` se ejecute; reintentar la Edge Function es seguro porque cada inversionista ya procesado tiene su fila en `liquidaciones_tramo_inversionista` — el bucle debe saltarse a quien ya tenga una fila registrada (idempotencia) |

## Cobertura de requisitos y criterios de éxito

Ver `data-model.md` → "Cobertura de requisitos" para el mapeo FR→implementación (se genera en
Phase 1). Criterios de éxito:

| Criterio | Cubierto por |
|---|---|
| SC-001 (100% de inversionistas pagados en una sola operación) | `liquidar-tramo/index.ts`, bucle completo por inversionista |
| SC-002 (100% de pagos verificables de forma independiente) | Pago real vía `pagarXlm` (Horizon) + quema real vía `burn` (contrato) — ambos con `tx_hash` registrado en `liquidaciones_tramo_inversionista` |
| SC-003 (un fallo individual no bloquea al resto del tramo) | Compensación por inversionista + continuación del bucle, `research.md` (a generar) |
| SC-004 (tramo sin aportes se liquida sin error) | `iniciar_liquidacion_tramo` con lista vacía de inversionistas → `finalizar_liquidacion_tramo` directo |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No aplica — el Constitution Check no reportó violaciones (ver tabla arriba).
