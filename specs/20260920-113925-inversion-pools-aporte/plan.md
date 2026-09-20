# Implementation Plan: Exploración de Pools y Primer Aporte del Inversionista

**Branch**: `20260920-113925-inversion-pools-aporte` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260920-113925-inversion-pools-aporte/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Capa de **backend** (Supabase) que deja creadas las entidades fundacionales del dominio de
inversión fraccionada (empresas, operaciones, pools, tramos, tipo de cambio, saldo de
demostración, cotizaciones, aportes, posiciones) y permite al inversionista explorar pools,
recargar saldo de demostración off-chain, cotizar y confirmar un aporte a un tramo. El aporte se
paga en XLM real de testnet desde la billetera del inversionista (ya custodiada por la plataforma
desde la feature previa) hacia una cuenta de custodia dedicada por pool, orquestado de forma
**síncrona** por una única Edge Function (`confirmar-aporte`) que reserva cupo+saldo en una
transacción de base de datos, somete el pago, y confirma o revierte — nunca deja la operación a
medias. Enfoque técnico: funciones RPC `security definer` para todo lo que no toca la red Stellar
ni Vault (catálogo, detalle, saldo, recarga, cotización, posiciones, y las tres internas
reservar/confirmar/revertir), dos Edge Functions nuevas que reutilizan el patrón ya construido de
generar+fondear+custodiar un keypair Stellar (una para la custodia de cada pool, otra para
orquestar el aporte), y una reorganización del seed existente en archivos idempotentes separados
por lo que es seguro para el proyecto remoto y lo que solo aplica en local. **No se construye
ningún frontend en este plan.**

## Technical Context

**Language/Version**: SQL/PL-pgSQL para migraciones, tablas, triggers y funciones RPC de Postgres
17 (versión local fijada en `config.toml`); TypeScript para las dos Edge Functions nuevas
(`supabase/functions/`, runtime Deno, mismo patrón que la feature previa). Sin código de
frontend.

**Primary Dependencies**: `@stellar/stellar-sdk` (ya usado por `provision-investor-wallet`;
extraído a un helper compartido `_shared/` para reutilizarlo en las dos Edge Functions nuevas sin
duplicar la lógica de generar/fondear/custodiar un keypair), Supabase Vault (custodia del secreto
de la wallet de custodia de cada pool y de la wallet del inversionista, ya establecida),
`pg_net` (ya habilitado por la feature previa, reutilizado por el nuevo trigger de aprovisionamiento
de custodia de pool).

**Storage**: Supabase Postgres — 9 tablas nuevas bajo `public`
(`empresas_pagadoras`, `operaciones`, `pools`, `tramos`, `tipos_cambio_referencia`,
`saldos_demostracion`, `recargas_saldo`, `cotizaciones`, `aportes`), más `vault.secrets`
(reutilizada, ahora también para el secreto de custodia por pool).

**Testing**: Sin tests automatizados (Principio I). Validación manual guiada por
`quickstart.md`, incluida una prueba de concurrencia real (20 aportes simultáneos vía
`Promise.all`) y una prueba de Friendbot ya ejecutada en vivo durante la investigación
(`research.md` §5) que confirma el supuesto central del diseño (recarga debe ser off-chain).

**Target Platform**: Supabase Cloud (proyecto `qqpozotcrxfukkwcoget`, ya vinculado) + Stellar
testnet (Horizon/Friendbot). Flujo de trabajo: siempre local (`supabase start` + Docker) primero,
`supabase db push` (solo migraciones) después de validar, seed de datos de ejemplo aplicado a
remoto de forma manual y explícita — nunca `db reset --linked`/`--include-seed` (ver
`quickstart.md` §7).

**Project Type**: servicio de backend/API (proyecto Supabase) — continúa exactamente la misma
estructura de la feature previa, sin componente de aplicación cliente.

**Performance Goals**: primer aporte confirmado en <3 min desde cuenta ya creada (SC-001);
ninguna de las funciones RPC de esta feature necesita más de un `UPDATE`/`INSERT` de una sola
fila — `research.md` §1 documenta por qué 5s de `statement_timeout` por función sobra incluso
bajo contención de 20 solicitudes simultáneas sobre el mismo cupo.

**Constraints**: dinero solo con tipos `numeric`, nunca `float` (Restricciones de la spec); XLM
con 7 decimales (`numeric(20,7)`); ningún rol de la API pública puede leer las tablas de dominio
directamente — todo pasa por funciones `security definer` (ver `data-model.md`); el cupo de un
tramo y el capital objetivo de un pool nunca se superan, ni con 20 aportes concurrentes (SC-002);
la Edge Function `confirmar-aporte` nunca deja un aporte pendiente de cara al cliente (FR-034,
research.md §3: timeout interno de 25s, muy por debajo del límite de plataforma de 150s).

**Scale/Scope**: escala de demo de hackathon — ≥5 pools, 3 cuentas demo de inversionista, decenas
de aportes de prueba; sin metas de escalabilidad de producción.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación |
|---|---|
| I. Velocidad sobre perfección, sin sacrificar estructura básica | **PASS**. Sin tests automatizados. Cada tabla/función/Edge Function tiene una sola responsabilidad (ver `data-model.md` y la lista de migraciones abajo — ninguna migración mezcla dominio con lógica de aporte); la lógica de generar/fondear/custodiar un keypair Stellar se extrae a un helper compartido en vez de duplicarse entre `provision-investor-wallet` y las dos Edge Functions nuevas, evitando archivos grandes y lógica repetida. |
| II. Stack flexible, decisión de equipo sobre dogma de herramientas | **PASS**. Exactamente el mismo backend ya acordado (Supabase); sin AWS ni infraestructura nueva, tal como pide el usuario explícitamente para este plan. |
| III. Arquitectura pragmática entre apps | **N/A** — no se construye ninguna app cliente en este plan. |
| IV. Un solo modelo de datos genérico ("activo fraccionable") | **Nota, sin violación**. Esta feature sí modela el caso de uso concreto de confirming (empresas, operaciones, pools, tramos) porque es exactamente lo que pide el Principio V (enfoque en el caso de uso principal) y la spec — no introduce una ramificación por tipo de activo distinta a confirming; el tipo de activo sigue siendo metadata implícita del dominio, no hay bifurcación de flujos. |
| V. Enfoque en confirming con pool y tranches | **PASS**. Es exactamente el flujo que este principio pide mostrar: fraccionamiento vía pool con tramos senior/junior, aplicado a confirming, de punta a punta (saldo → explorar → detalle → aportar → posiciones), demostrable en <3 min. |
| VI. Evidencia on-chain real, no simulada (NON-NEGOTIABLE) | **PASS**. El pago del aporte es una transacción `Payment` de XLM real en testnet, firmada con la llave custodiada del inversionista, sometida a Horizon — nunca simulada en el backend. El único elemento "simulado" permitido por la propia spec (FR-033) es el **comprobante** como contingencia documentada mientras el mecanismo on-chain no esté desplegado — nunca la lógica de pool/tramo en sí, que siempre corre como transacción real. |
| VII. Toda la infraestructura de Supabase vive versionada en el repositorio (NON-NEGOTIABLE) | **PASS, con una corrección activa**. Todo objeto (tablas, triggers, funciones, el nuevo Database Webhook de custodia de pool) se define en `supabase/migrations/`, nunca desde el Dashboard. Este plan además **corrige** un hallazgo de `research.md` §2: el webhook de wallet de la feature previa, aunque versionado, tenía una URL de entorno hardcodeada que rompía el desarrollo local — se corrige con una migración adicional (`CREATE OR REPLACE FUNCTION`), no editando la migración ya aplicada. |

Sin violaciones → no se requiere Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260920-113925-inversion-pools-aporte/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/            # Phase 1 output
│   ├── catalogo-pools.md
│   ├── detalle-pool.md
│   ├── saldo-demostracion.md
│   ├── cotizar-aporte.md
│   ├── confirmar-aporte-function.md
│   ├── provision-pool-custody-function.md
│   └── mis-posiciones.md
└── tasks.md              # Phase 2 output (/speckit-tasks — NOT created by this plan)
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   ├── 0001_perfiles.sql                        # (feature previa, sin cambios)
│   ├── 0002_wallet_provisioning.sql              # (feature previa, sin cambios — no se edita una
│   │                                              #  migración ya aplicada)
│   ├── 0003_dominio_pools.sql                    # enums + empresas_pagadoras, operaciones,
│   │                                              # pools, tramos — RLS habilitada sin políticas,
│   │                                              # revoke explícito a anon/authenticated
│   ├── 0004_config_edge_functions_url.sql        # obtener_url_base_functions() + CREATE OR
│   │                                              # REPLACE de trigger_provision_wallet() para
│   │                                              # dejar de hardcodear la URL de producción
│   │                                              # (research.md §2)
│   ├── 0005_custodia_pools.sql                   # aprovisionar_custodia_pool() + trigger +
│   │                                              # Database Webhook hacia provision-pool-custody,
│   │                                              # reutilizando 0004 desde el principio
│   ├── 0006_tipo_cambio.sql                      # tipos_cambio_referencia + tipo_cambio_vigente()
│   ├── 0007_saldo_demostracion.sql               # saldos_demostracion, recargas_saldo +
│   │                                              # mi_saldo_demostracion(), recargar_saldo_demo()
│   ├── 0008_cotizaciones_aportes.sql             # cotizaciones, aportes + cotizar_aporte(),
│   │                                              # reservar_aporte(), confirmar_aporte(),
│   │                                              # revertir_aporte(), mis_posiciones()
│   └── 0009_catalogo_consultas.sql               # catalogo_pools(), detalle_pool()
├── functions/
│   ├── _shared/
│   │   └── stellar-keypair.ts                    # extraído de provision-investor-wallet: generar
│   │                                              # keypair + fondear Friendbot + guardar en Vault
│   ├── provision-investor-wallet/index.ts        # (feature previa) refactor mínimo: usa el helper
│   │                                              # compartido en vez de duplicar la lógica
│   ├── provision-pool-custody/index.ts           # nueva — mismo patrón, para la cuenta de
│   │                                              # custodia de cada pool
│   └── confirmar-aporte/index.ts                 # nueva — orquestación síncrona del aporte
│       └── _shared/stellar-payment.ts             # construir/someter el Payment + checar balance
└── seed/
    ├── 00_auth_demo_local.sql                    # SOLO LOCAL — crea auth.users/identities demo
    │                                              # (idéntico contenido al seed.sql actual,
    │                                              # con ON CONFLICT DO NOTHING añadido)
    ├── 01_dominio_demo.sql                       # seguro para remoto — ≥5 pools, tramos,
    │                                              # empresas, operaciones, tipo de cambio inicial
    └── 02_saldos_y_posiciones_demo.sql           # seguro para remoto — saldo demo + ≥1 posición
                                                    # previa para las 3 cuentas demo (referenciadas
                                                    # por su id fijo, sin volver a crearlas)

supabase/seed.sql                                  # ELIMINADO — su contenido se migra íntegro a
                                                     # 00_auth_demo_local.sql (ver research.md §2 y
                                                     # quickstart.md)
supabase/config.toml                                # [db.seed] sql_paths pasa de ["./seed.sql"]
                                                     # a ["./seed/*.sql"]
```

**Structure Decision**: continúa exactamente bajo `supabase/`, mismo patrón de la feature previa
(migraciones numeradas de una sola responsabilidad, Edge Functions con contrato documentado,
seed versionado). No se crea ninguna carpeta `apps/` nueva ni se toca `contracts/soroban-pool/`
(placeholder del contrato Soroban futuro, fuera de alcance — el diseño de custodia por pool de
esta feature es justamente lo que permite que ese contrato se enchufe después sin romper el
contrato de API, ver `research.md` §4).

## Orden de implementación recomendado

1. `0003_dominio_pools.sql` — sin esto nada más tiene sobre qué construirse.
2. `0004_config_edge_functions_url.sql` — corrige el hallazgo de local antes de introducir un
   segundo webhook que repetiría el mismo problema.
3. `_shared/stellar-keypair.ts` (extraído del `provision-investor-wallet` actual) +
   `0005_custodia_pools.sql` + `provision-pool-custody/index.ts` — sin custodia por pool, ningún
   aporte puede probarse de punta a punta más adelante.
4. `0006_tipo_cambio.sql` — bloquea `cotizar_aporte` y `detalle_pool` (equivalente en XLM).
5. `0007_saldo_demostracion.sql` — bloquea `cotizar_aporte` (validación de saldo) y toda la
   Historia 3.
6. `0009_catalogo_consultas.sql` — puede construirse en paralelo con el paso 5 (no depende de
   saldo ni de aportes), pero se lista después porque `detalle_pool` usa `tipo_cambio_vigente()`
   del paso 4.
7. `0008_cotizaciones_aportes.sql` + `confirmar-aporte/index.ts` (+ `_shared/stellar-payment.ts`)
   — el corazón de Historia 4; depende de todo lo anterior.
8. `supabase/seed/*.sql` + retirar `supabase/seed.sql` + actualizar `config.toml` — al final,
   porque siembra datos usando ya todas las tablas/enums definitivos.
9. Validación de punta a punta con `quickstart.md` (incluida la prueba de 20 aportes simultáneos)
   antes de tocar el proyecto remoto.

## Cobertura de requisitos y criterios de éxito

### Requisitos funcionales

| Requisitos | Cubiertos por |
|---|---|
| FR-001 – FR-002 | `saldos_demostracion` (PK compuesta por moneda) + `mi_saldo_demostracion()` — `data-model.md`, `contracts/saldo-demostracion.md` |
| FR-003 – FR-006 | `recargar_saldo_demo()`, `recargas_saldo`, `pg_advisory_xact_lock` por (inversionista, día Lima) — `research.md` §1, `data-model.md`, `contracts/saldo-demostracion.md` |
| FR-007 | Validación de `perfiles.wallet_public_key IS NULL` dentro de `recargar_saldo_demo()`/`cotizar_aporte()` (`PA007`) |
| FR-008 | Documentado como requisito de presentación en `contracts/saldo-demostracion.md`; el propio contrato nunca mezcla el saldo demo con un equivalente XLM |
| FR-009 – FR-012 | `catalogo_pools()` — `0009_catalogo_consultas.sql`, `contracts/catalogo-pools.md` |
| FR-013 – FR-019 | `detalle_pool()` — `0009_catalogo_consultas.sql`, `contracts/detalle-pool.md`, cálculo de `colchon_junior_pct` derivado (no columna) en `data-model.md` |
| FR-020 | `cotizar_aporte()` — `0008_cotizaciones_aportes.sql`, `contracts/cotizar-aporte.md` (expiración fija de 5 min) |
| FR-021 – FR-023 | Validaciones dentro de `cotizar_aporte()`/`reservar_aporte()` (`PA001`/`PA002`/`PA003`) — `data-model.md` §Registro de códigos de error |
| FR-024 | `aportes.tipo_cambio_aplicado` copiado de la cotización, nunca recalculado — `data-model.md` §Aporte |
| FR-025 | `PA004`/`PA005` en `reservar_aporte()` |
| FR-026 | `UPDATE` condicional atómico sobre `tramos` — `research.md` §1 (la garantía central de concurrencia) |
| FR-027 | `unique (investor_id, idempotency_key)` en `aportes` + `reservar_aporte()` devuelve el resultado existente en vez de duplicar — `data-model.md` §Aporte |
| FR-028 | `PA006` en `reservar_aporte()` |
| FR-029 | `PA007` también aplicado a `cotizar_aporte()`/`confirmar-aporte` |
| FR-030 | `PA008` en todas las funciones de cliente relacionadas con aportar |
| FR-031 | Paso 4 de `contracts/confirmar-aporte-function.md` (chequeo de balance XLM real vs. Horizon antes de pagar) — `PA009` |
| FR-032 | Paso 2 y 5 de `contracts/confirmar-aporte-function.md`; `tramos_actualiza_estado_pool` trigger para el avance agregado |
| FR-033 | `aportes.tx_hash`/`comprobante_simulado` — `data-model.md` §Aporte, `contracts/confirmar-aporte-function.md` §Salida |
| FR-034 | Orquestación síncrona completa de `confirmar-aporte`, timeout interno de 25s — `research.md` §3 |
| FR-035 – FR-036 | `mis_posiciones()` — `0008_cotizaciones_aportes.sql`, `contracts/mis-posiciones.md` (sin parámetro de identidad, siempre `auth.uid()`) |
| FR-037 | `tipos_cambio_referencia` (histórico con `vigente_desde` y `nota` de rotulado) — `0006_tipo_cambio.sql` |
| FR-038 | Todos los contratos de pool/cotización/aporte/posición devuelven ambos valores; excepción explícita documentada para saldo demo en `contracts/saldo-demostracion.md` |
| FR-039 | `check` en `operaciones` + trigger `operaciones_moneda_coincide_pool` — `data-model.md` §Operación |
| FR-040 – FR-043 | `supabase/seed/01_dominio_demo.sql` y `02_saldos_y_posiciones_demo.sql`, `ON CONFLICT DO NOTHING` sobre claves estables (`pools.codigo`, ids fijos de cuentas demo) — `quickstart.md` §1 y §7 |

### Criterios de éxito

| Criterio | Cubierto por |
|---|---|
| SC-001 (< 3 min primer aporte) | Flujo end-to-end de `quickstart.md` §2–4, sin pasos manuales adicionales una vez autenticado |
| SC-002 (cupo nunca superado, 20 simultáneos) | `research.md` §1 (mecanismo) + `quickstart.md` §5 (prueba real con `Promise.all`) |
| SC-003 (total de aportes = avance de fondeo) | Consulta de verificación explícita en `quickstart.md` §5; se sostiene porque `capital_comprometido` y `aportes.estado='confirmado'` se actualizan en la misma transacción de `reservar_aporte()`/`confirmar_aporte()` |
| SC-004 (100% de montos con ambos equivalentes) | Ver cobertura de FR-038 arriba |
| SC-005 (usuario sin conocimientos financieros entiende senior/junior) | `detalle_pool.comparacion_tramos` en lenguaje simple — `contracts/detalle-pool.md` (validación cualitativa, fuera del alcance de una prueba automatizable en este plan) |
| SC-006 (demo de punta a punta solo con datos de ejemplo) | `quickstart.md` completo, sin ninguna acción del operador de banco |
| SC-007 (100% de aportes con comprobante rotulado) | `aportes.tx_hash`/`comprobante_simulado` NOT NULL por diseño (uno de los dos siempre se fija en `confirmar_aporte()`) |
| SC-008 (tope diario nunca superado, ni simultáneo) | `pg_advisory_xact_lock` en `recargar_saldo_demo()` — `research.md` §1 + `quickstart.md` §3 (prueba de concurrencia) |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No aplica — el Constitution Check no reportó violaciones (ver tabla arriba).
