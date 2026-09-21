# Implementation Plan: Originación de Facturas y Tokenización de Fracciones de Pool

**Branch**: `20260920-174938-originacion-facturas-pool` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260920-174938-originacion-facturas-pool/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Cierra el círculo entre "hay pools en los que invertir" (spec previa) y "esos pools están
respaldados por facturas reales, con evidencia on-chain verificable" (esta spec). Un operador de
banco registra y valida facturas de demostración, las asigna manualmente a un pool/tramo definiendo
un anticipo por factura (el fraccionamiento sale de la suma acumulada de anticipos, redondeada
hacia abajo a la unidad mínima del pool; el residuo queda como reserva del pool, sin rechazar
ninguna factura). Cada tramo de cada pool se representa on-chain como una instancia propia de un
contrato Soroban (`pool_fraction_token`, SEP-41, `decimals=0`, 1 unidad = 1 fracción = 1 unidad
mínima) que **es la fuente de verdad**: registra la huella de cada factura (nunca sus datos) y
emite fracciones a un inversionista solo después de que su aporte ya se pagó en XLM real — nunca
antes. El flujo síncrono ya construido de `confirmar-aporte` se extiende con un paso de emisión
on-chain entre el pago y la confirmación, con reintento acotado y **compensación automática** (XLM
de vuelta al inversionista) si el contrato falla de forma definitiva — nunca deja el aporte
pendiente. El inversionista ve las facturas de cada pool en versión anonimizada (nunca proveedor ni
deudor) junto con hechos de estado de cobro (pendiente/cobrada/en mora), sin ningún cálculo de
rendimiento. **No se construye ningún frontend en este plan** — sigue siendo capacidad de
backend/contrato, como ambas specs previas.

## Technical Context

**Language/Version**: SQL/PL-pgSQL para migraciones y funciones RPC de Postgres 17 (igual que las
dos features previas); TypeScript/Deno para las Edge Functions nuevas y modificadas (mismo runtime
ya en uso); **Rust (edición 2021) + `soroban-sdk`** para el contrato inteligente nuevo
(`contracts/soroban-pool`) — primera vez que este proyecto compila código Rust/WASM. Sin código de
frontend.

**Primary Dependencies**: `@stellar/stellar-sdk@^17` (actualizado desde `^13` durante la
implementación — esa versión no parsea `getTransaction()` contra protocolo 28, ver tasks.md); ya en
uso, se extiende con su módulo `rpc`
para invocar Soroban, sin dependencia nueva de `package.json`), Supabase Vault (ahora también para
el secreto de la autoridad de plataforma que administra los contratos), `pg_net`/Database Webhooks
(ya habilitados, reutilizados por el nuevo webhook de aprovisionamiento de contrato por tramo),
`soroban-sdk` (crate de Rust, nueva dependencia solo del lado del contrato), `stellar-cli`
(herramienta de despliegue, no una dependencia del runtime).

**Storage**: Supabase Postgres — 2 tablas nuevas (`proveedores`, `configuracion_red`), 1 tabla
renombrada (`operaciones` → `facturas`) con columnas nuevas, 2 tablas existentes ampliadas
(`tramos`, `aportes`, `pools`); **Stellar testnet** como segundo almacén de estado, ahora también
vía contratos Soroban (antes solo cuentas clásicas/Horizon) — cada instancia de contrato es su
propio "almacén" de balances de fracciones, fuente de verdad para esa parte del dominio
(`research.md` §2).

**Testing**: Sin tests automatizados de integración (Principio I, igual que las dos features
previas). El contrato Soroban sí incluye **pruebas unitarias en Rust** (`cargo test`, usando el
entorno de pruebas de `soroban-sdk`) — es la única parte de todo el proyecto con tests, porque es
la única pieza que, si tiene un bug, no se puede simplemente "arreglar y redesplegar" sin dejar
rastro (una vez emitidas fracciones incorrectas on-chain, deshacerlo es una operación manual
costosa) — justifica el único apartamiento del Principio I. Validación manual del resto guiada por
`quickstart.md`, incluida una prueba de concurrencia real y una prueba explícita de fallo del
contrato con compensación.

**Target Platform**: Supabase Cloud (mismo proyecto ya vinculado) + Stellar testnet, ahora también
Soroban RPC (`https://soroban-testnet.stellar.org`) además de Horizon clásico. Flujo de trabajo
igual que las features previas: local primero, `db push` después de validar, seed remoto explícito
— más un paso nuevo, exclusivo de esta feature: el despliegue del contrato (`contracts/scripts/
deploy.sh`) ocurre **fuera** de Supabase, contra testnet directamente, antes de que cualquier
migración que dependa de `configuracion_red` tenga datos útiles.

**Project Type**: servicio de backend/API + contrato inteligente — continúa la misma estructura de
`supabase/` y añade `contracts/soroban-pool/` (hoy un placeholder vacío) como un segundo
componente de primera clase del repositorio.

**Performance Goals**: sin metas de throughput nuevas — el volumen sigue siendo de demo de
hackatón. El único presupuesto de tiempo nuevo es el de latencia por invocación a Soroban: cada
llamada a `register_invoice`/`mint` debe resolverse (incluidos reintentos) dentro de un presupuesto
interno de ~45s (3 intentos × ~15s de poll cada uno) para que `asignar-factura`/`confirmar-aporte`
sigan respondiendo bien por debajo del límite de plataforma de 150s de una Edge Function.

**Constraints**: fracciones siempre como enteros (`integer` en Postgres, `i128` en el contrato),
nunca `numeric` (`data-model.md`); el contrato nunca recibe ni almacena datos identificables de
proveedor/deudor, solo una huella `BytesN<32>` (FR-016, Principio VI); ninguna Edge Function firma
nada con una llave que no lea de Vault en el momento de usarla (nunca en variables de entorno en
texto plano, mismo estándar ya vigente); el cupo on-chain de un tramo (`Cap`) nunca decrece
(refuerza FR-012 en la propia capa de contrato).

**Scale/Scope**: 1 contrato fuente (crate), ~10-14 instancias desplegadas (una por tramo de los
≥5 pools de ejemplo, más los que se creen durante la demo), decenas de invocaciones de prueba —
sigue siendo escala de demo, sin metas de producción.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación |
|---|---|
| I. Velocidad sobre perfección, sin sacrificar estructura básica | **PASS**. El contrato Soroban es la única pieza con tests automatizados, justificado explícitamente arriba (Technical Context → Testing) como la excepción razonada, no como una relajación general del principio. Cada migración nueva mantiene una sola responsabilidad (ver Project Structure); ninguna Edge Function existente crece más allá de un paso adicional bien delimitado (`asignar-factura` es nueva y propia, `confirmar-aporte` gana un bloque, no una reescritura). |
| II. Stack flexible, decisión de equipo sobre dogma de herramientas | **PASS**. Soroban/Rust ya estaba anunciado como parte del stack inicial de la constitución (`Core Principles` → Principio II); este plan es la primera vez que se materializa, sin desviarse de lo ya acordado. |
| III. Arquitectura pragmática entre apps | **N/A** — sigue sin construirse ninguna app cliente en este plan. |
| IV. Un solo modelo de datos genérico ("activo fraccionable") | **Nota, sin violación**. Se profundiza el mismo caso de uso de confirming (facturas, proveedores, deudores) sin introducir un segundo tipo de activo ni una ramificación de flujos — es exactamente el Principio V materializándose, no una excepción al Principio IV. |
| V. Enfoque en confirming con pool y tranches | **PASS**. Es el tramo que faltaba del flujo completo que este principio exige mostrar en la demo: "emisión → fraccionamiento → compra" (originación de facturas + tokenización) se suma a "pago → distribución" (ya construido) — el flujo de punta a punta de la constitución queda completo con esta feature. |
| VI. Evidencia on-chain real, no simulada (NON-NEGOTIABLE) | **PASS, y es el corazón de este plan**. Antes de esta feature, "pool" y "tramo" eran conceptos puramente de Postgres; ahora cada tramo es una instancia real de un contrato Soroban en testnet, y una fracción de inversionista no existe hasta que el contrato la emite — el contrato manda (`research.md` §2), nunca al revés. Ningún dato de negocio se simula on-chain; lo único "simulado" que sobrevive de la spec previa (comprobante XLM mientras el mecanismo real no estuviera listo) deja de aplicar en la práctica porque esta feature es precisamente ese mecanismo. |
| VII. Toda la infraestructura de Supabase vive versionada en el repositorio (NON-NEGOTIABLE) | **PASS**. Todas las tablas/funciones/triggers/webhooks nuevos viven en `supabase/migrations/` y `supabase/functions/`, nunca en el Dashboard. El contrato y sus IDs desplegados también quedan versionados, en `contracts/soroban-pool/` (código fuente) y `contracts/deployments/testnet.json` (IDs por red) — mismo espíritu del principio extendido a la parte on-chain del proyecto, que la constitución no cubría explícitamente pero que este plan trata con el mismo estándar. |

Sin violaciones → no se requiere Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260920-174938-originacion-facturas-pool/
├── plan.md                              # This file
├── research.md                          # Phase 0 output
├── data-model.md                        # Phase 1 output
├── quickstart.md                        # Phase 1 output
├── contracts/                           # Phase 1 output
│   ├── soroban-pool-token.md            # Interfaz del contrato (funciones, errores, eventos)
│   ├── registrar-factura.md             # RPC registrar_factura + listar_facturas_operador
│   ├── asignar-factura-function.md      # Edge Function asignar-factura (reservar→contrato→confirmar/revertir)
│   ├── facturas-del-pool.md             # RPC facturas_del_pool + extensión de detalle_pool
│   ├── confirmar-aporte-extension.md    # Delta sobre el contrato ya existente de la spec previa
│   ├── provision-pool-tramo-token-function.md  # Webhook de aprovisionamiento por tramo
│   └── deploy-contrato.md               # Script de despliegue inicial del WASM + instancias
└── tasks.md                             # Phase 2 output (/speckit-tasks — NOT created by this plan)
```

### Source Code (repository root)

```text
contracts/
├── soroban-pool/                        # (hoy placeholder vacío — esta feature lo llena)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs                       # implementación de pool_fraction_token
│   │   └── test.rs                      # pruebas unitarias (única parte del proyecto con tests)
│   └── Cargo.lock
├── scripts/
│   └── deploy.sh                        # sube WASM, instancia por tramo, puebla configuracion_red
└── deployments/
    └── testnet.json                     # IDs de contrato + wasm_hash por red (versionado, sin secretos)

supabase/
├── migrations/
│   ├── 0001_perfiles.sql … 0009_catalogo_consultas.sql   # (features previas, sin cambios)
│   ├── 0010_configuracion_red.sql        # tabla configuracion_red + wrappers de Vault
│   ├── 0011_proveedores_facturas.sql     # proveedores; rename operaciones→facturas; columnas
│   │                                      # nuevas de originación; columnas nuevas de tramos
│   │                                      # (monto_financiado_acumulado, reserva,
│   │                                      # fracciones_totales, token_contract_id); trigger
│   │                                      # tramos_capital_objetivo_multiplo; margen_plazo_dias
│   │                                      # en pools
│   ├── 0012_registro_y_asignacion_facturas.sql  # registrar_factura, listar_facturas_operador,
│   │                                      # asignar_factura_a_pool, confirmar_asignacion_factura,
│   │                                      # revertir_asignacion_factura
│   ├── 0013_facturas_del_pool_y_detalle.sql     # facturas_del_pool() + CREATE OR REPLACE de
│   │                                      # catalogo_pools()/detalle_pool() (rename + bloque
│   │                                      # estado_facturas)
│   ├── 0014_provision_pool_tramo_token.sql      # trigger_provision_pool_tramo_token() + trigger
│   │                                      # + Database Webhook
│   └── 0015_mint_fracciones_aporte.sql   # aportes.fraccion_tx_hash, nuevo valor de enum
│                                          # 'fallo_emision_fracciones', obtener_secreto_custodia_pool()
├── functions/
│   ├── _shared/
│   │   └── stellar-soroban.ts            # nuevo — invocarContratoAdmin() + consulta de solo lectura
│   ├── asignar-factura/index.ts          # nueva
│   ├── provision-pool-tramo-token/index.ts  # nueva
│   └── confirmar-aporte/index.ts         # MODIFICADA — paso de mint + compensación
└── seed/
    └── 03_originacion_facturas_demo.sql  # nuevo — retrocompleta facturas ya sembradas + agrega
                                            # facturas en varios estados + una asignación en vivo
```

**Structure Decision**: `contracts/soroban-pool/` deja de ser un placeholder (commit `f82fff9`,
`.gitkeep`) y se convierte en el segundo componente de primera clase del repositorio, junto a
`supabase/`. Ninguna migración ya aplicada de las dos features previas se edita — todo cambio sobre
objetos existentes (`operaciones`→`facturas`, `catalogo_pools`, `detalle_pool`,
`trigger_provision_wallet`-style) sigue el patrón ya establecido de `CREATE OR REPLACE`/`ALTER
TABLE` en una migración nueva (precedente: `0004_config_edge_functions_url.sql` sobre
`0002_wallet_provisioning.sql`).

## Orden de implementación recomendado

1. **`contracts/soroban-pool`** (crate Rust + pruebas unitarias) — es la pieza de mayor riesgo
   técnico y la que exige el checkpoint del 23-sep ("arquitectura, esquema del contrato... y
   repositorio inicial"); debe existir, compilar y tener su interfaz estable antes de que cualquier
   migración de Postgres la dé por hecha.
2. **`0010_configuracion_red.sql`** — sin esta tabla, nada puede leer dónde vive el contrato.
3. **`contracts/scripts/deploy.sh`** (ejecutado una vez contra testnet) — sube el WASM, puebla
   `configuracion_red`. Puede correrse en paralelo con el paso 4 una vez que el paso 1 esté
   estable.
4. **`0011_proveedores_facturas.sql`** — rename + columnas nuevas; bloquea todo lo demás del
   dominio de facturas.
5. **`0012_registro_y_asignacion_facturas.sql`** — Historia 1 y la mitad de Postgres de Historia 2.
6. **`_shared/stellar-soroban.ts`** + **`asignar-factura/index.ts`** — completa Historia 2 y 3
   (el registro on-chain de facturas).
7. **`0014_provision_pool_tramo_token.sql`** + **`provision-pool-tramo-token/index.ts`** — puede
   construirse en paralelo con el paso 6, pero debe estar listo antes de sembrar tramos nuevos o de
   correr `deploy.sh` sobre los tramos ya existentes (que se aprovisionan de forma retroactiva por
   el script, no por este webhook — `contracts/provision-pool-tramo-token-function.md`).
8. **`0013_facturas_del_pool_y_detalle.sql`** — Historia 4 y 5; depende del paso 4 (columnas de
   `facturas`) pero no de la asignación en sí (puede probarse con datos de ejemplo estáticos antes
   de que el flujo de asignación esté terminado).
9. **`0015_mint_fracciones_aporte.sql`** + modificar **`confirmar-aporte/index.ts`** — el último
   eslabón: depende de que los pasos 2-7 ya existan (necesita `token_contract_id` poblado en al
   menos un tramo para probarse de punta a punta).
10. **`supabase/seed/03_originacion_facturas_demo.sql`** — al final, sobre el esquema definitivo.
11. Validación de punta a punta con `quickstart.md` (incluida la prueba de concurrencia y la de
    fallo/compensación) antes de tocar el proyecto remoto.

**Nota sobre el checkpoint del 23-sep-2026**: los pasos 1-3 (contrato + esquema de configuración +
despliegue) son deliberadamente lo primero de la lista — son exactamente lo que ese checkpoint
exige poder mostrar, incluso si los pasos 4-11 (integración completa con Postgres) todavía están en
curso el día del checkpoint.

## Riesgos técnicos y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Primera vez que el equipo compila/despliega Soroban — curva de aprendizaje bajo plazo ajustado | Alto — puede consumir varios de los 5 días disponibles | Contrato deliberadamente mínimo (sin lógica de reparto, cobro ni liquidación); se apoya en el ejemplo oficial de token de `soroban-examples` como base, en vez de diseñar desde cero; skill `smart-contracts` ya documenta el flujo completo de build/test/deploy |
| Archivado de estado por TTL expirado durante la ventana del hackatón | Medio — un contrato "dormido" deja de responder hasta restaurarse | TTL extendido al máximo permitido en cada llamada administrativa (`register_invoice`/`mint`), `research.md` §3; ventana total del hackatón (5 días) muy por debajo del máximo de TTL disponible en testnet |
| Fallo del contrato después de que el pago XLM ya se ejecutó | Medio — dinero real de testnet movido sin fracción emitida | Reintento acotado + compensación automática (reembolso XLM custodia→inversionista) antes de revertir el aporte — `research.md` §2, `contracts/confirmar-aporte-extension.md` |
| Condición de carrera entre la validación de cupo en Postgres y el `mint` en el contrato | Bajo (Postgres ya reserva el cupo monetario antes de invocar el contrato) | El contrato valida `Cap` de nuevo por sí mismo (`CapExceeded`) como defensa en profundidad — nunca depende únicamente de que Postgres se comporte correctamente (FR-014) |
| Llave de la autoridad de plataforma comprometida (punto único de administración de todos los contratos) | Alto si ocurriera, baja probabilidad en una demo de hackatón | Custodiada en Vault, nunca en variables de entorno ni en el repositorio; mecanismo de rotación (`set_admin`) documentado y disponible aunque no automatizado (`research.md` §5) |
| Inestabilidad/latencia del RPC público de Soroban testnet durante la demo en vivo | Medio — una invocación lenta podría acercarse al límite de 150s de la Edge Function | Presupuesto interno de ~45s (3 intentos × ~15s) muy por debajo del límite de plataforma; simulación previa (`prepareTransaction`) evita someter transacciones que ya se sabe que fallarán, ahorrando reintentos innecesarios |
| Checkpoint del 23-sep llega antes de que la integración completa esté lista | Medio | Orden de implementación (arriba) prioriza explícitamente contrato + esquema + despliegue inicial como los primeros 3 pasos, exactamente lo que el checkpoint exige mostrar |

## Cobertura de requisitos y criterios de éxito

Ver `data-model.md` → "Cobertura de requisitos" para el mapeo FR→implementación. Criterios de
éxito:

| Criterio | Cubierto por |
|---|---|
| SC-001 – SC-002 (facturas siempre aprobadas/rechazadas de inmediato; una sola asignación por factura) | `registrar_factura`/`asignar_factura_a_pool`, `quickstart.md` §1, §3-4 |
| SC-003 (el contrato nunca emite más fracciones que el cupo, 20 simultáneos) | `Cap`/`TotalSupply` del contrato + `quickstart.md` §8 |
| SC-004 (inversionista nunca ve proveedor/deudor) | `facturas_del_pool` (sin esas columnas en el `select`) + RLS deny-all — dos capas, `quickstart.md` §6 |
| SC-005 (fracciones verificables directamente en testnet) | `balance()`/`cap()`/`total_supply()` del contrato, `quickstart.md` §3 y §7 |
| SC-006 (cambio de estado de cobro reflejado en <5s) | `estado_facturas` de `detalle_pool` calculado en vivo, sin denormalización — instantáneo por diseño |
| SC-007 (pool demostrable de punta a punta sin acción manual del operador durante la demo) | `quickstart.md` §11 (seed con una asignación ya en vivo, más una factura aprobada lista para asignarse en vivo durante la demo) |
| SC-008 (0 menciones de rendimiento/retorno asociadas al estado de cobro) | `contracts/facturas-del-pool.md` — `estado_facturas` nunca incluye una cifra de rendimiento |
| SC-009 (reserva de un tramo nunca alcanza una unidad mínima adicional) | Invariante aritmético de `asignar_factura_a_pool` (floor + residuo), `data-model.md` → tramos |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No aplica — el Constitution Check no reportó violaciones (ver tabla arriba).
