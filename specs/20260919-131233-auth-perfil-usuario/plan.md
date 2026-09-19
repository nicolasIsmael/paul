# Implementation Plan: Registro, Inicio de Sesión y Perfil de Usuario

**Branch**: `20260919-131233-auth-perfil-usuario` | **Date**: 2026-09-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/20260919-131233-auth-perfil-usuario/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Capa de **backend** de identidad de la plataforma (Supabase): registro y login exclusivamente
con email/contraseña (sin login social — decisión explícita del equipo), con rol fijo
inversionista/operador de banco expuesto vía la API de autenticación, y una API de perfil
consultable/editable con las restricciones correspondientes. Para inversionistas, el registro
aprovisiona automáticamente una wallet de Stellar testnet real (keypair + fondeo vía Friendbot)
cuya llave privada queda bajo custodia total de la plataforma en Supabase Vault, nunca expuesta
vía la API pública. El enfoque técnico: Supabase Auth para identidad, un trigger de Postgres
para crear el perfil con el rol ya fijado en el mismo `signUp()`, un Database Webhook + Edge
Function para el aprovisionamiento asíncrono de la wallet, y RLS + privilegios de columna para
blindar los campos no editables y el secreto de la wallet. **No se construye ningún frontend en
este plan** — todo lo entregado es esquema de base de datos, funciones y políticas consumibles
como API; qué cliente (móvil, web, u otro) las consuma es responsabilidad de una feature
separada.

## Technical Context

**Language/Version**: SQL/PL-pgSQL para migraciones, triggers y funciones RPC de Postgres;
TypeScript para la única Edge Function (`supabase/functions/`, runtime Deno). Rust/Soroban queda
fuera de alcance de este plan (interfaz externa). Sin código de frontend de ningún tipo.

**Primary Dependencies**: `@stellar/stellar-sdk` (import `npm:` en la Edge Function, para
`Keypair.random()` y el fondeo en testnet), extensión nativa **Supabase Vault** (sin dependencia
npm) para el cifrado del secreto de la wallet. `@supabase/supabase-js` aparece únicamente en
`contracts/` como referencia del contrato que cualquier cliente futuro usaría para consumir esta
API — no se instala ni se ejecuta ninguna app cliente como parte de este plan.

**Storage**: Supabase Postgres — `auth.users` (gestionada por Supabase), `public.perfiles`
(perfil por rol), `vault.secrets` (secreto cifrado de la wallet, built-in de Supabase Vault).

**Testing**: Sin tests automatizados, consistente con el Principio I de la constitución del
proyecto. La validación es manual, guiada por `quickstart.md` (llamadas directas a la API/SQL) y
las cuentas de demostración (Historia 4), antes de cada ensayo de la demo.

**Target Platform**: Supabase Cloud (Postgres + Auth + Edge Functions) como backend único. Los
clientes finales (iOS/Android vía Expo, navegador vía Next.js) son consumidores futuros de esta
API, fuera de alcance de este plan.

**Project Type**: servicio de backend/API (proyecto Supabase) — sin componente de aplicación
cliente en este plan.

**Performance Goals**: respuesta de autenticación con rol incluido en <15s (SC-003), consulta de
perfil completo (incluida wallet) en <1 min para cuentas de demostración (SC-005) — metas medidas
directamente sobre la API, no sobre una interfaz de usuario.

**Constraints**: la llave privada de la wallet NUNCA se almacena ni se transmite en texto plano
(FR-014); ningún rol de la API pública (`anon`/`authenticated`) puede leer el secreto cifrado ni
su vista descifrada; el rol de una cuenta es inmutable una vez fijado (FR-003); una semana de
desarrollo con equipo de 3 (constitución del proyecto).

**Scale/Scope**: escala de demo de hackathon — decenas de cuentas (reales + de demostración), no
miles de usuarios concurrentes; sin metas de escalabilidad de producción.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Evaluación |
|---|---|
| I. Velocidad sobre perfección, sin sacrificar estructura básica | **PASS**. Sin tests automatizados (validación manual vía `quickstart.md`). Cada tabla/función/Edge Function tiene una sola responsabilidad (perfiles, aprovisionamiento de wallet, seed); estructura de carpetas predecible (`supabase/migrations`, `supabase/functions`); ningún archivo planeado supera unas pocas decenas de líneas. Sin login social, el flujo de fijar el rol se simplifica a una sola vía (email/contraseña en el propio `signUp()`), sin estado transitorio `rol = NULL` ni función de "completar registro". |
| II. Stack flexible, decisión de equipo sobre dogma de herramientas | **PASS**. Usa exactamente el backend ya acordado (Supabase); sin AWS ni infraestructura propia añadida. |
| III. Arquitectura pragmática entre apps | **N/A para este plan** — no se construye ninguna app en esta feature, así que no hay relación entre apps que decidir aquí. El diseño no acopla la API a ningún cliente específico (ni móvil ni web), dejando esa decisión íntegramente a la feature de frontend que consuma este backend. |
| IV. Un solo modelo de datos genérico ("activo fraccionable") | **N/A para esta feature** — este módulo es la capa de identidad/perfil que habilita el flujo de activos, no modela activos en sí. Sin conflicto. |
| V. Enfoque en confirming con pool y tranches | **PASS con nota**. Esta feature es infraestructura habilitante obligatoria (sin cuenta no hay compra de fracciones); no agrega nada fuera del flujo de demo objetivo. |
| VI. Evidencia on-chain real, no simulada | **PASS**. El keypair de Stellar se genera y se fondea realmente en testnet vía Friendbot (no simulado en el backend); Vault custodia la llave privada, pero las transacciones futuras se firman y envían a la red real. |
| VII. Toda la infraestructura de Supabase vive versionada en el repositorio | **PASS**. Toda tabla, RLS, trigger y función (`handle_new_user`, `perfiles_rol_inmutable`) se define en archivos SQL bajo `supabase/migrations/`; el propio Database Webhook se crea como sentencia SQL (`create trigger ... execute function net.http_post(...)` desde una función `SECURITY DEFINER`), no desde el Dashboard (ver `research.md` §3). Sin login social no queda ninguna excepción pendiente: todas las credenciales del sistema (email/contraseña) las gestiona Supabase Auth nativamente, sin secretos de terceros que configurar en el Dashboard. |

Sin violaciones → no se requiere Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/20260919-131233-auth-perfil-usuario/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
supabase/
├── migrations/
│   ├── 0001_perfiles.sql              # tabla perfiles, enum rol (NOT NULL), RLS, allow-list de columna
│   └── 0002_wallet_provisioning.sql   # handle_new_user(), perfiles_rol_inmutable(),
│                                       # aprovisionamiento de wallet + trigger del Database
│                                       # Webhook (función SECURITY DEFINER + net.http_post()) —
│                                       # Principio VII: nunca creado desde el Dashboard
├── functions/
│   └── provision-investor-wallet/
│       └── index.ts                   # genera keypair, funda con Friendbot, guarda en Vault
└── seed.sql                           # datos de prueba (perfiles + auth.users demo)

contracts/                             # fuera de alcance de este plan (contrato Soroban)
```

Sin login social, este plan no tiene ninguna excepción pendiente al Principio VII: no hay
credenciales de terceros que configurar en el Dashboard — todo el mecanismo de autenticación
(email/contraseña) lo gestiona Supabase Auth de forma nativa, sin configuración adicional fuera
de lo ya versionado en `supabase/migrations/`.

No existe carpeta `apps/` en el alcance de este plan: ningún código de aplicación cliente
(móvil o web) se crea aquí. `contracts/<feature>/` (en `specs/`, no en la raíz) documenta la API
resultante para que una feature de frontend futura la consuma sin tener que inspeccionar el
esquema de la base de datos directamente.

**Structure Decision**: Todo el trabajo de esta feature vive bajo `supabase/` (migraciones,
funciones, seed). No se crea ninguna carpeta `apps/mobile` ni `apps/web-admin` en este plan — esa
estructura, cuando exista, pertenece a una feature de frontend separada que consumirá esta API
(Principio III de la constitución: la relación entre apps se decide en esa feature, sobre la
marcha, no aquí).

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No aplica — el Constitution Check no reportó violaciones (ver tabla arriba).
