---
description: "Task list for feature implementation"
---

# Tasks: Registro, Inicio de Sesión y Perfil de Usuario

**Input**: Design documents from `specs/20260919-131233-auth-perfil-usuario/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Sin tests automatizados (Principio I de la constitución del proyecto — velocidad sobre
cobertura de tests). Cada historia de usuario se cierra con una tarea de validación manual que
ejecuta las secciones correspondientes de `quickstart.md` contra un proyecto Supabase real, en su
lugar.

**Organization**: Las tareas están agrupadas por historia de usuario para permitir implementación
y validación independientes de cada una. Esta feature es exclusivamente de backend (Supabase) —
no existen tareas de frontend/UI en este documento.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Puede ejecutarse en paralelo (archivo distinto, sin dependencias pendientes)
- **[Story]**: A qué historia de usuario pertenece la tarea (US1, US2, US3, US4)
- **`[~]`**: tarea eliminada por un cambio de alcance posterior (login social descartado) — se
  conserva el ID y la explicación por trazabilidad, no se renumera el resto
- Cada tarea incluye la ruta de archivo exacta

## Path Conventions

Todo el trabajo vive bajo `supabase/` (migraciones SQL en `supabase/migrations/`, Edge Function en
`supabase/functions/`, datos de prueba en `supabase/seed.sql`), tal como define
`plan.md` → Project Structure. No hay carpeta `apps/` en el alcance de esta feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Preparar el andamiaje del proyecto Supabase antes de escribir cualquier migración.

- [x] T001 Crear las carpetas `supabase/migrations/` y `supabase/functions/provision-investor-wallet/` (scaffold vacío) siguiendo la estructura de `plan.md` → Project Structure
- [~] T002 **Eliminada** — el equipo decidió explícitamente no incorporar login social (Google u otro proveedor OAuth); el registro/login es exclusivamente email/contraseña, nativo de Supabase Auth, sin credenciales de terceros que configurar
- [x] T003 [P] Crear `.env.example` en la raíz del repo documentando `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y cualquier secreto que necesite la Edge Function, dejando los valores reales fuera de git (ya cubierto por `.gitignore`)

**Checkpoint**: Andamiaje listo — se puede empezar a escribir migraciones.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Esquema base de `public.perfiles` que las 4 historias de usuario necesitan por igual.

**⚠️ CRITICAL**: Ninguna historia de usuario puede implementarse hasta que esta fase esté completa.

- [x] T004 Crear el enum `perfil_rol` (`'inversionista'`, `'operador_banco'`) y la tabla `public.perfiles` en `supabase/migrations/0001_perfiles.sql` con las columnas exactas de `data-model.md`: `id uuid primary key references auth.users(id) on delete cascade`; `rol perfil_rol not null` (siempre se fija en el propio `signUp()`, sin login social); `nombre_completo text not null`; `telefono text null`; `foto_url text null`; `wallet_public_key text null`; `wallet_secret_id uuid null`; `es_cuenta_demo boolean not null default false`; `created_at timestamptz not null default now()`; `updated_at timestamptz not null default now()`
- [x] T005 Agregar el check constraint `wallet_fields_solo_inversionista` a `public.perfiles` en `supabase/migrations/0001_perfiles.sql`: `wallet_public_key` y `wallet_secret_id` DEBEN ser `NULL` cuando `rol = 'operador_banco'` (data-model.md → Validación)
- [x] T006 Agregar función trigger `set_updated_at()` y el trigger `before update` correspondiente sobre `public.perfiles` en `supabase/migrations/0001_perfiles.sql` para refrescar `updated_at` en cada `UPDATE`
- [x] T007 Habilitar RLS (`alter table public.perfiles enable row level security;`) y agregar políticas `select`/`update` restringidas a `auth.uid() = id` sobre `public.perfiles` en `supabase/migrations/0001_perfiles.sql`; NO agregar política de `insert` para `anon`/`authenticated` (research.md §5)
- [x] T008 Agregar los privilegios de columna sobre `public.perfiles` en `supabase/migrations/0001_perfiles.sql`: `revoke select, update on public.perfiles from authenticated;` seguido de un `grant select (...)`/`grant update (nombre_completo, telefono, foto_url)` explícito (allow-list) — un `revoke` de columna aislado no basta en Supabase, ver corrección documentada en research.md §5 — de modo que solo esas 3 columnas queden editables y `wallet_secret_id` sea ilegible vía la API (FR-011, FR-014)

**Checkpoint**: Esquema base listo — las historias de usuario pueden empezar.

---

## Phase 3: User Story 1 - Registro de cuenta con rol y datos de perfil (Priority: P1) 🎯 MVP

**Goal**: Cualquier persona puede registrarse con email/contraseña con un rol explícito y fijo;
los inversionistas obtienen automáticamente una wallet de Stellar testnet real, custodiada por la
plataforma.

**Independent Test**: Enviar una solicitud de registro para cada rol directamente contra la API de
autenticación y verificar (vía la API de perfil) que la cuenta queda creada con el rol elegido, los
datos correctos y — solo para inversionista — una wallet de Stellar testnet real y fondeada.

### Implementation for User Story 1

- [x] T009 [US1] Crear la función trigger `public.handle_new_user()` (`SECURITY DEFINER`) y el trigger `after insert on auth.users` en `supabase/migrations/0002_wallet_provisioning.sql`: inserta en `public.perfiles` usando `rol`/`nombre_completo`/`telefono` de `raw_user_meta_data` (siempre presentes: único método de registro es email/contraseña) — data-model.md, ciclo de vida punto 1
- [x] T010 [US1] Crear la función trigger `public.perfiles_rol_inmutable()` y el trigger `before update on public.perfiles` en `supabase/migrations/0002_wallet_provisioning.sql`: rechaza cualquier `UPDATE` que intente cambiar el `rol` ya fijado (FR-003)
- [~] T011 **Eliminada** — `completar_registro_oauth()` solo existía para el caso de login social (rol fijado en un paso posterior al `INSERT`); sin Google, el rol siempre viaja explícito en el propio `signUp()` (T009), así que esta función y su complejidad asociada (estado transitorio `rol = NULL`) ya no aplican
- [x] T012 [US1] Crear la función `public.aprovisionar_wallet_inversionista(perfil_id uuid, wallet_public_key text, wallet_secret text)` (`SECURITY DEFINER`, ejecutable solo por `service_role`) en `supabase/migrations/0002_wallet_provisioning.sql`: llama a `vault.create_secret(wallet_secret)` y actualiza `perfiles.wallet_public_key`/`wallet_secret_id` de forma atómica (contracts/provision-investor-wallet-function.md, pasos 3-4)
- [x] T013 [P] [US1] Implementar en `supabase/functions/provision-investor-wallet/index.ts` el parseo del payload del Database Webhook y la generación del keypair con `Keypair.random()` (`npm:@stellar/stellar-sdk`) — research.md §2
- [x] T014 [US1] Implementar en `supabase/functions/provision-investor-wallet/index.ts` el fondeo en testnet vía Friendbot (`GET https://friendbot.stellar.org?addr={publicKey}`), sin continuar si el fondeo falla (depende de T013)
- [x] T015 [US1] Implementar en `supabase/functions/provision-investor-wallet/index.ts` la llamada a `aprovisionar_wallet_inversionista` (con el cliente `service_role`) tras el fondeo exitoso, devolviendo `{ ok: true, wallet_public_key }` o `{ ok: false, error }` per contracts/provision-investor-wallet-function.md (depende de T012, T014)
- [x] T016 [US1] Desplegar la Edge Function (`supabase functions deploy provision-investor-wallet`) y crear el trigger del Database Webhook — función `trigger_provision_wallet()` + `create trigger ... after insert on public.perfiles for each row execute function trigger_provision_wallet()` (simplificado a solo `INSERT` tras quitar el login social: el rol nunca se fija vía `UPDATE`) — en `supabase/migrations/0002_wallet_provisioning.sql`, apuntando a la URL desplegada; creado **solo por SQL**, nunca desde el Dashboard (Principio VII, research.md §3) (depende de T009, T015)
- [x] T017 [US1] Aplicar `0001_perfiles.sql` y `0002_wallet_provisioning.sql` contra el proyecto Supabase real "Stellar Odyssey" (`qqpozotcrxfukkwcoget`) — vía el MCP de Supabase (`apply_migration`) en esta sesión, equivalente a `supabase db push` (depende de T004-T012, T016)
- [x] T018 [US1] Validado contra el proyecto real: registro por seed + trigger produjo una wallet de Stellar testnet real y fondeada (confirmada en Horizon: 10,000 XLM); duplicado de email confirmado sin crear fila nueva. Encontró y corrigió 3 bugs reales: `email_change` quedaba `NULL` en el seed (rompía la detección de duplicados de GoTrue para cualquier registro), `aprovisionar_wallet_inversionista` no era idempotente ante reintentos del webhook, y timeout de `pg_net` (5s) insuficiente para el flujo Friendbot — ver research.md §3 y §5. (Nota: en el momento de esta validación aún existía `completar_registro_oauth` para el caso Google, ya probado con una cuenta sintética antes de eliminarse — ver T011.) El registro real vía `/auth/v1/signup` con un email nuevo no se probó de punta a punta por el límite de envío de emails del plan gratuito de Supabase (confirmado como `over_email_send_rate_limit`, no un bug de esta implementación)

**Checkpoint**: Historia 1 completa y validable de forma independiente — MVP demostrable.

---

## Phase 4: User Story 2 - Inicio de sesión con rol de cuenta disponible para el frontend (Priority: P2)

**Goal**: Una cuenta ya creada puede autenticarse (mismo método usado al registrarse) y la
respuesta de autenticación expone su rol fijo, sin que este plan implemente ninguna navegación.

**Independent Test**: Autenticarse con una cuenta ya existente de cada rol directamente contra la
API y verificar que la respuesta de autenticación incluye el rol correcto.

### Implementation for User Story 2

- [x] T019 [US2] Validado con `curl` contra la API real: `signInWithPassword` de una cuenta demo devolvió un access token JWT válido, y la consulta subsiguiente a `perfiles` expuso `rol` correctamente (FR-007, FR-008) — único método de login soportado, validado de punta a punta

**Checkpoint**: Historias 1 y 2 funcionan de forma independiente.

---

## Phase 5: User Story 3 - Ver y editar información de perfil (Priority: P3)

**Goal**: Una persona autenticada puede consultar su perfil completo y editar únicamente los
campos permitidos; email y rol nunca son editables desde esta operación.

**Independent Test**: Consultar el perfil de una cuenta existente de cada rol, editar un campo
editable y confirmar que se persiste, e intentar editar email/rol/wallet y confirmar el rechazo.

### Implementation for User Story 3

- [x] T020 [US3] Validado con `curl` + JWT real contra la API: lectura de perfil propio con columnas explícitas OK; `select("wallet_secret_id")` → 403; `PATCH {rol: "operador_banco"}` → 403; `PATCH {telefono: "..."}` sin pedir representación completa → 204 y persistido. Este ciclo de pruebas encontró que el `REVOKE`/`GRANT` de columna original (T008) no funcionaba como estaba documentado — ver la corrección aplicada y explicada en T008/research.md §5 (FR-009, FR-010, FR-011, SC-004)

**Checkpoint**: Historias 1, 2 y 3 funcionan de forma independiente.

---

## Phase 6: User Story 4 - Acceso mediante cuentas de demostración precargadas (Priority: P4)

**Goal**: Existen varias cuentas de ejemplo (inversionistas + operador) con credenciales conocidas,
con perfil y wallet ya poblados, para explorar la plataforma sin registrarse.

**Independent Test**: Autenticarse con las credenciales de una cuenta de demostración de cada rol y
verificar, vía la API de perfil, que los datos (y la wallet, si aplica) ya están poblados.

### Implementation for User Story 4

- [x] T021 [US4] Escribir `supabase/seed.sql`: insertar varias filas de `auth.users` de demostración (inversionistas + 1 operador) con `encrypted_password = crypt('<password>', gen_salt('bf'))` y `email_confirmed_at` fijado, de modo que `handle_new_user()` (T009) se dispare igual que en un registro real y cada inversionista demo reciba una wallet real vía el mismo Database Webhook (T016) — FR-012, data-model.md punto 5
- [x] T022 [US4] Agregar a `supabase/seed.sql` la actualización `es_cuenta_demo = true` sobre las filas de `perfiles` creadas en T021
- [x] T023 [P] [US4] Documentar las credenciales de las cuentas de demostración en `README.md` (no como secreto, per Assumptions de spec.md)
- [x] T024 [US4] Aplicado `seed.sql` contra el proyecto real (vía MCP `execute_sql`) y validado: las 4 cuentas demo se crearon con `rol`/`nombre_completo`/`telefono` correctos y `es_cuenta_demo = true`; login real con `inversionista.demo1@paul.test` devolvió un JWT válido; las 3 cuentas de inversionista demo tienen wallet de Stellar testnet real y fondeada (verificado en `perfiles` y en Horizon) (depende de T016, T021, T022)

**Checkpoint**: Las 4 historias de usuario funcionan de forma independiente entre sí.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cierre de la feature — documentación y regresión completa.

- [x] T025 [P] Actualizar `README.md` con la explicación de la arquitectura de esta feature (tablas, triggers, funciones, Edge Function) requerida por las bases de la hackatón (sección 07) y por el Principio VII de la constitución — el repositorio debe explicarse a sí mismo sin depender del Dashboard
- [x] T026 Migraciones aplicadas + Edge Function desplegada contra el proyecto real; regresión corrida manualmente vía `curl`/MCP para todas las secciones de `quickstart.md` (registro y login son exclusivamente email/contraseña, sin ningún flujo OAuth pendiente de regresionar) (depende de T018, T019, T020, T024)
- [x] T027 [P] Advisors de seguridad y performance revisados — encontraron y permitieron corregir 2 vulnerabilidades críticas reales (funciones `SECURITY DEFINER` invocables por `anon`/`authenticated` vía RPC pública) y 1 optimización de RLS; solo quedan 2 WARN de bajo riesgo sin corregir: `pg_net` en el esquema `public` (cosmético) y "Leaked Password Protection" desactivado (toggle de Dashboard, recomendado activar)
- [x] T028 Regresión final de `quickstart.md` tras retirar el login social, contra el proyecto real: login de cuenta demo (inversionista y operador) expone `rol` correctamente; login con credenciales inexistentes → 400; lectura de perfil con columnas explícitas OK, `select("wallet_secret_id")` → 403, `PATCH {rol}` → 403, `PATCH {telefono}` → 204 (y revertido al valor original del seed); registro simulado vía `INSERT` directo en `auth.users` (equivalente a `signUp()`, evita el `over_email_send_rate_limit` ya documentado) creó el perfil con `rol` NOT NULL y una wallet Stellar testnet real, verificada en Horizon (10,000 XLM); registro duplicado sobre ese mismo email devolvió la respuesta "fantasma" anti-enumeración (200, `identities: []`) sin crear una segunda fila en `auth.users`/`perfiles`; cuenta de prueba eliminada al terminar, solo quedan las 4 filas originales de `perfiles`. Advisors de seguridad y performance re-verificados: mismos 2 WARN de bajo riesgo ya conocidos, 0 hallazgos nuevos

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias — puede iniciar de inmediato.
- **Foundational (Phase 2)**: depende de Setup — BLOQUEA las 4 historias de usuario.
- **Historias de usuario (Phase 3-6)**: todas dependen de Foundational.
  - US2 y US3 además dependen de que T017 (deploy de la migración `0001`) haya corrido, pero no
    dependen entre sí ni de que US1 haya terminado su Edge Function/webhook.
  - US4 depende de que US1 exista completa (T009, T016) porque reutiliza el mismo trigger y
    Database Webhook para dar wallets reales a las cuentas demo.
- **Polish (Phase 7)**: depende de que las historias que se quieran entregar estén completas.

### User Story Dependencies

- **US1 (P1)**: puede empezar apenas termina Foundational — sin dependencia de otras historias.
- **US2 (P2)**: puede empezar apenas termina Foundational; en la práctica se valida después de que
  exista al menos una cuenta creada por US1, pero no requiere código nuevo de US1.
- **US3 (P3)**: igual que US2 — sin código nuevo propio, solo requiere Foundational.
- **US4 (P4)**: requiere que US1 esté completa (trigger `handle_new_user` + Database Webhook +
  Edge Function desplegada) para que las cuentas demo obtengan wallets reales, no simuladas.

### Parallel Opportunities

- T013 (Edge Function) puede empezar en paralelo con T009-T012 (funciones SQL) porque son archivos
  distintos, aunque T015 sí depende de que T012 exista antes de desplegar.
- T023 (documentar credenciales demo) puede correr en paralelo con T021/T022 (mismo objetivo,
  archivo distinto).
- T025 y T027 (Polish) pueden correr en paralelo entre sí.

---

## Parallel Example: inicio de User Story 1

```bash
# En Historia 1, la Edge Function puede empezar mientras se terminan las funciones SQL:
Task: "Implementar parseo del webhook y generación de keypair en supabase/functions/provision-investor-wallet/index.ts"
Task: "Crear la función trigger perfiles_rol_inmutable en supabase/migrations/0002_wallet_provisioning.sql"
```

---

## Implementation Strategy

### MVP First (User Story 1 solamente)

1. Completar Fase 1: Setup.
2. Completar Fase 2: Foundational (CRÍTICO — bloquea todas las historias).
3. Completar Fase 3: Historia 1 (registro con rol fijo + wallet real).
4. **DETENERSE Y VALIDAR**: correr `quickstart.md` secciones 1-3 de forma independiente.
5. Esto ya es una demo mostrable: cuentas reales con wallets reales en testnet.

### Incremental Delivery

1. Setup + Foundational → esquema base listo.
2. Historia 1 → validar independientemente → primer hito demostrable (MVP).
3. Historia 2 → validar independientemente (sin código nuevo, solo confirma que el rol se expone).
4. Historia 3 → validar independientemente (sin código nuevo, solo confirma RLS/REVOKE).
5. Historia 4 → validar independientemente → habilita demos sin registro en vivo.
6. Cada historia suma valor sin romper las anteriores.

### Team Strategy (equipo de 3)

Dado que Foundational y US1 concentran casi todo el trabajo de código nuevo (migraciones + Edge
Function), y US2/US3 son principalmente validación, tiene sentido que una persona lleve
Foundational + US1 de punta a punta mientras otra prepara US4 (seed) en paralelo tan pronto como
T009/T016 estén disponibles, y la tercera se enfoque en README/Polish y en el contrato Soroban
(fuera de este plan) que consumirá `wallet_secret_id` más adelante.

---

## Notes

- [P] = archivos distintos, sin dependencias pendientes entre sí.
- [Story] mapea cada tarea a su historia de usuario para trazabilidad.
- No hay tareas de frontend/UI: esta feature termina en la capa de API/backend (ver spec.md →
  Fuera de Alcance).
- Sin tests automatizados (Principio I); cada historia cierra con una tarea de validación manual
  contra `quickstart.md`.
- Todo objeto de Supabase (tablas, RLS, triggers, funciones, el propio Database Webhook) se crea
  como archivo SQL versionado — nunca desde el Dashboard (Principio VII). Sin login social no
  queda ninguna excepción pendiente: la única vía permitida para el Dashboard es
  inspeccionar/depurar.
- T002 y T011 quedaron marcadas `[~]` (eliminadas): el equipo decidió no incorporar login social,
  lo que hizo innecesarias tanto la configuración de Google OAuth como la función
  `completar_registro_oauth()` y el estado transitorio `rol = NULL` que la motivaba.
- Hacer commit después de cada tarea o grupo lógico de tareas.
