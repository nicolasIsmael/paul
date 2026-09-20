---
description: "Task list for feature implementation"
---

# Tasks: Exploración de Pools y Primer Aporte del Inversionista

**Input**: Design documents from `specs/20260920-113925-inversion-pools-aporte/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Sin tests automatizados (Principio I de la constitución). Cada historia de usuario se
cierra con una tarea de validación manual que ejecuta las secciones correspondientes de
`quickstart.md` contra el stack local primero, y contra el proyecto remoto solo en la fase final
de Polish.

**Organization**: Las tareas están agrupadas por historia de usuario para permitir
implementación y validación independientes de cada una. Feature exclusivamente de backend
(Supabase) — no hay tareas de frontend/UI.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Puede ejecutarse en paralelo (archivo distinto, sin dependencias pendientes)
- **[Story]**: A qué historia de usuario pertenece la tarea (US1, US2, US3, US4, US5)
- Cada tarea incluye la ruta de archivo exacta

## Path Conventions

Todo el trabajo vive bajo `supabase/` (migraciones en `supabase/migrations/`, Edge Functions en
`supabase/functions/`, datos de ejemplo en `supabase/seed/`), tal como define `plan.md` → Project
Structure. No hay carpeta `apps/` en el alcance de esta feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Reorganizar el seed existente antes de tocar cualquier esquema nuevo (research.md
§2, plan.md → Project Structure).

- [X] T001 [P] Crear `supabase/seed/00_auth_demo_local.sql` moviendo el contenido íntegro del
  `supabase/seed.sql` actual (las 4 cuentas demo en `auth.users`/`auth.identities`), añadiendo
  `on conflict (id) do nothing` a ambos `insert` (hoy no lo tienen) y un encabezado que marque el
  archivo explícitamente como **solo local — nunca ejecutar contra el proyecto remoto**, donde
  esas cuentas ya existen de verdad; luego eliminar `supabase/seed.sql`
- [X] T002 [P] Actualizar `supabase/config.toml`: cambiar `[db.seed] sql_paths` de
  `["./seed.sql"]` a `["./seed/*.sql"]` (los archivos se aplican en orden alfabético, de ahí el
  prefijo numérico de cada uno)

**Checkpoint**: Seed reorganizado — se puede empezar a escribir el esquema de dominio.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Esquema de dominio (empresas, operaciones, pools, tramos) y tipo de cambio de
referencia — compartidos por 4 de las 5 historias de usuario (todas menos US5, que solo los
necesita transitivamente vía `pools`).

**⚠️ CRITICAL**: Ninguna historia de usuario puede implementarse hasta que esta fase esté completa.

- [X] T003 Crear en `supabase/migrations/0003_dominio_pools.sql` los enums exactos de
  `data-model.md`: `moneda_soportada` (`'PEN'`, `'USD'`), `sector_empresa` (`'retail'`,
  `'manufactura'`, `'servicios'`, `'construccion'`, `'tecnologia'`), `perfil_riesgo_pool`
  (`'conservador'`, `'balanceado'`, `'agresivo'`), `estado_pool` (`'abierto'`, `'fondeado'`,
  `'cerrado'`), `tipo_tramo` (`'senior'`, `'junior'`)
- [X] T004 Crear tabla `public.empresas_pagadoras` en `0003_dominio_pools.sql` con las columnas
  exactas de `data-model.md`: `id uuid primary key default gen_random_uuid()`;
  `nombre_comercial text not null`; `sector public.sector_empresa not null`;
  `created_at timestamptz not null default now()`
- [X] T005 Crear tabla `public.pools` en `0003_dominio_pools.sql` con las columnas exactas:
  `id uuid primary key default gen_random_uuid()`; `codigo text not null unique`;
  `nombre text not null`; `descripcion_corta text not null`;
  `moneda public.moneda_soportada not null`; `plazo_dias integer not null check (plazo_dias in
  (30, 60, 90))`; `perfil_riesgo public.perfil_riesgo_pool not null`;
  `perfil_riesgo_explicacion text not null`; `fecha_apertura timestamptz not null default now()`;
  `fecha_vencimiento_esperada date not null`;
  `estado public.estado_pool not null default 'abierto'`;
  `unidad_minima_aporte numeric(14,2) not null check (unidad_minima_aporte > 0)`;
  `custody_public_key text`; `custody_secret_id uuid`; `created_at timestamptz not null default
  now()`; `updated_at timestamptz not null default now()` (mismo trigger `set_updated_at()` ya
  creado en `0001_perfiles.sql`, reutilizado aquí, no duplicado)
- [X] T006 Crear tabla `public.tramos` en `0003_dominio_pools.sql` con las columnas exactas:
  `id uuid primary key default gen_random_uuid()`; `pool_id uuid not null references
  public.pools(id)`; `tipo public.tipo_tramo not null`;
  `capital_objetivo numeric(14,2) not null check (capital_objetivo > 0)`;
  `capital_comprometido numeric(14,2) not null default 0 check (capital_comprometido >= 0 and
  capital_comprometido <= capital_objetivo)`;
  `rendimiento_ilustrativo_plazo_pct numeric(6,3) not null`;
  `rendimiento_ilustrativo_anualizado_pct numeric(6,3) not null`;
  `created_at`/`updated_at timestamptz not null default now()`; constraint
  `unique (pool_id, tipo)` (data-model.md: "exactamente un tramo senior y uno junior por pool")
- [X] T007 Crear tabla `public.operaciones` en `0003_dominio_pools.sql` con las columnas exactas:
  `id uuid primary key default gen_random_uuid()`; `pool_id uuid not null references
  public.pools(id)`; `empresa_id uuid not null references public.empresas_pagadoras(id)`;
  `moneda public.moneda_soportada not null`;
  `monto_nominal numeric(14,2) not null check (monto_nominal > 0)`;
  `created_at timestamptz not null default now()`; y el trigger
  `operaciones_moneda_coincide_pool` (`before insert or update`) que rechaza si
  `new.moneda <> (select moneda from public.pools where id = new.pool_id)` (FR-039, refuerza a
  nivel de dato que un pool solo agrupa operaciones de su propia moneda)
- [X] T008 Crear la función trigger `public.tramos_actualiza_estado_pool()` y su trigger
  `after update of capital_comprometido on public.tramos` en `0003_dominio_pools.sql`: si, tras el
  `update`, ambos tramos del pool tienen `capital_comprometido = capital_objetivo` y
  `pools.estado = 'abierto'`, actualiza `pools.estado = 'fondeado'` (data-model.md → máquina de
  estados del Pool, única vía de la transición automática)
- [X] T009 En `0003_dominio_pools.sql`, habilitar RLS sin políticas (`alter table ... enable row
  level security;`, deny-all por defecto) y ejecutar `revoke all on public.empresas_pagadoras,
  public.operaciones, public.pools, public.tramos from anon, authenticated;` sobre las 4 tablas —
  ningún cliente las lee jamás directamente, solo vía `catalogo_pools`/`detalle_pool`
  (`security definer`); recordar que Supabase concede privilegios de tabla completa por defecto a
  `authenticated` en toda tabla nueva de `public`, así que el `revoke` explícito es obligatorio,
  no opcional (mismo hallazgo que `research.md` de la feature previa, §5)
- [X] T010 [P] Crear en `supabase/migrations/0006_tipo_cambio.sql` la tabla
  `public.tipos_cambio_referencia` (histórico append-only): `id uuid primary key default
  gen_random_uuid()`; `moneda public.moneda_soportada not null`;
  `tasa_moneda_por_xlm numeric(18,7) not null check (tasa_moneda_por_xlm > 0)`;
  `vigente_desde timestamptz not null default now()`; `nota text` — más la función
  `public.tipo_cambio_vigente(p_moneda public.moneda_soportada)` (`security definer`,
  `set search_path = ''`) que devuelve la fila con `vigente_desde` más reciente para esa moneda o
  ninguna fila si no existe; `revoke all ... from anon, authenticated` sobre la tabla (depende de
  T003 por el enum `moneda_soportada`)

**Checkpoint**: Esquema de dominio y tipo de cambio listos — las historias de usuario pueden
empezar.

---

## Phase 3: User Story 1 - Explorar y comparar pools de inversión (Priority: P1) 🎯 MVP

**Goal**: Cualquier inversionista autenticado puede listar los pools disponibles y filtrar/ordenar
por plazo, moneda, perfil de riesgo, sector y avance de fondeo.

**Independent Test**: Con datos de ejemplo cargados, llamar `catalogo_pools` con distintas
combinaciones de filtros y orden y verificar que los resultados son correctos, sin necesitar saldo
ni llegar a cotizar/aportar.

### Implementation for User Story 1

- [X] T011 [US1] Crear la función `public.catalogo_pools(p_moneda, p_plazo_dias,
  p_perfil_riesgo, p_sector, p_estado, p_orden)` (`security definer`, `set search_path = ''`,
  `set statement_timeout = '5s'`, todos los parámetros `default null` salvo `p_orden default
  'avance_desc'`) en `supabase/migrations/0009_catalogo_consultas.sql`: agrega, filtra
  (combinables) y ordena sobre `pools`/`tramos` (capital objetivo/comprometido siempre sumados
  desde `tramos`, nunca una columna denormalizada) y `operaciones` (para el filtro de sector, sin
  exponerlas) — contracts/catalogo-pools.md
- [X] T012 [US1] En `0009_catalogo_consultas.sql`, `revoke all on function
  public.catalogo_pools(...) from public, anon, authenticated;` seguido de
  `grant execute ... to authenticated;` (nunca a `anon` — todo este flujo requiere sesión)
- [X] T013 [P] [US1] Crear `supabase/seed/01_dominio_demo.sql`: ≥5 pools ficticios vía
  `insert ... on conflict (codigo) do nothing` cubriendo distintos plazos (30/60/90), monedas
  (mayoría `'PEN'`, ≥1 `'USD'`), perfiles de riesgo y sectores; sus 2 tramos cada uno (senior +
  junior, con `capital_objetivo`/rendimientos ilustrativos); ≥1 empresa y operación por pool, sin
  marcas reales; y el tipo de cambio de referencia inicial en `tipos_cambio_referencia` con
  `nota = 'Parámetro de demostración — testnet, sin valor de mercado real'`. Fijar
  `capital_comprometido` inicial de los tramos para lograr los 4 estados de avance que pide
  FR-041: un pool casi vacío, uno a medio fondear, uno casi lleno y uno completamente fondeado
  (en este último, dejar que el trigger de T008 lo pase a `estado = 'fondeado'` automáticamente,
  no fijarlo a mano)
- [X] T014 [US1] Validar Historia 1 en local (`supabase db reset`) siguiendo `quickstart.md` §1
  (custodia/wallets aprovisionadas) y §2: listar pools, filtrar por moneda+riesgo, ordenar por
  avance, y confirmar que el pool completamente fondeado del seed aparece con
  `estado: "fondeado"`

**Checkpoint**: Historia 1 completa y validable de forma independiente — MVP demostrable
(explorar pools con datos reales de ejemplo).

---

## Phase 4: User Story 2 - Ver el detalle de un pool para decidir (Priority: P1)

**Goal**: El inversionista puede abrir el detalle de cualquier pool y entender, en lenguaje
simple, qué compone el pool y qué diferencia hay entre aportar al tramo senior o al junior.

**Independent Test**: Abrir el detalle de cada pool de ejemplo y verificar que toda la
información agregada requerida está presente y es consistente con los datos cargados, sin
necesitar que el usuario llegue a aportar.

### Implementation for User Story 2

- [X] T015 [US2] Continuar `supabase/migrations/0009_catalogo_consultas.sql` (mismo archivo de
  T011) agregando `public.detalle_pool(p_pool_id uuid)` (`security definer`,
  `set search_path = ''`, `set statement_timeout = '5s'`): nombre/descripción/moneda/plazo/
  vencimiento/perfil de riesgo/estado; composición agregada (`numero_operaciones`,
  `numero_empresas`, `sectores`, `concentracion_maxima_pct` — la operación más grande sobre el
  total del pool) sin exponer ninguna operación/empresa individual (FR-014); por cada tramo,
  rendimiento ilustrativo de plazo y anualizado, capital objetivo/comprometido, avance y cupo
  disponible; `colchon_junior_pct` **derivado** (`tramo_junior.capital_objetivo /
  (tramo_senior.capital_objetivo + tramo_junior.capital_objetivo) * 100`, nunca una columna);
  `aporte_minimo` con `equivalente_xlm` vía `tipo_cambio_vigente(pools.moneda)` — si no hay tasa,
  `equivalente_xlm: null` y `tipo_cambio_disponible: false`, **sin fallar la llamada**;
  `comparacion_tramos` en lenguaje simple; `PA012` si `p_pool_id` no existe —
  contracts/detalle-pool.md
- [X] T016 [US2] En `0009_catalogo_consultas.sql`, mismo patrón de privilegios que T012 para
  `detalle_pool`: `revoke all ... from public, anon, authenticated` + `grant execute ... to
  authenticated`
- [X] T017 [US2] Validar Historia 2 en local siguiendo `quickstart.md` §2 completo: abrir el
  detalle de un pool con y sin tipo de cambio disponible (probar ambos casos manipulando
  `tipos_cambio_referencia`), y confirmar que ninguna respuesta incluye una operación o empresa
  individual

**Checkpoint**: Historias 1 y 2 funcionan de forma independiente — el inversionista ya puede
explorar y entender un pool antes de decidir.

---

## Phase 5: User Story 3 - Ver y recargar saldo de demostración (Priority: P1)

**Goal**: El inversionista puede ver su saldo de demostración por moneda y recargarlo dentro de
un tope diario compartido, sin que la recarga mueva XLM en la red.

**Independent Test**: Consultar el saldo de una cuenta demo, recargar un monto dentro del tope
permitido, y verificar que el saldo aumenta y queda disponible de inmediato, sin necesidad de
explorar pools ni aportar.

### Implementation for User Story 3

- [X] T018 [US3] Crear en `supabase/migrations/0007_saldo_demostracion.sql` la tabla
  `public.saldos_demostracion`: `investor_id uuid not null references auth.users(id) on delete
  cascade`; `moneda public.moneda_soportada not null`;
  `saldo numeric(14,2) not null default 0 check (saldo >= 0)`;
  `updated_at timestamptz not null default now()`;
  `primary key (investor_id, moneda)` (data-model.md: "como máximo una fila por inversionista y
  moneda"); `revoke all ... from anon, authenticated` + `alter table ... enable row level
  security` sin políticas
- [X] T019 [US3] Crear en `0007_saldo_demostracion.sql` la tabla `public.recargas_saldo`:
  `id uuid primary key default gen_random_uuid()`;
  `investor_id uuid not null references auth.users(id)`;
  `moneda public.moneda_soportada not null`;
  `monto numeric(14,2) not null check (monto > 0)`;
  `monto_equivalente_soles numeric(14,2) not null`;
  `tipo_cambio_referencia_aplicado numeric(18,7)`;
  `created_at timestamptz not null default now()`; índice
  `idx_recargas_saldo_investor_dia on (investor_id, ((created_at at time zone
  'America/Lima')::date))`; mismos `revoke`/RLS que T018
- [X] T020 [US3] Crear `public.mi_saldo_demostracion()` (`security definer`,
  `set search_path = ''`) en `0007_saldo_demostracion.sql`: devuelve `(moneda, saldo)` por cada
  fila de `saldos_demostracion` del `auth.uid()` actual; `revoke all ... from public, anon,
  authenticated` + `grant execute ... to authenticated` — contracts/saldo-demostracion.md
- [X] T021 [US3] Crear `public.recargar_saldo_demo(p_moneda, p_monto)` (`security definer`,
  `set search_path = ''`, `set statement_timeout = '5s'`) en `0007_saldo_demostracion.sql`:
  rechaza con `PA008` si `perfiles.rol <> 'inversionista'`, con `PA007` si
  `perfiles.wallet_public_key is null`; toma
  `pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || (now() at time zone
  'America/Lima')::date::text, 0))` (research.md §1 — serializa solo las recargas del mismo
  inversionista en el mismo día Lima); calcula lo ya recargado hoy (suma
  `monto_equivalente_soles` de `recargas_saldo` del día Lima actual) y rechaza con `PA011`
  (incluyendo `disponible_para_recargar_hoy` y `se_reinicia_at` = próxima medianoche Lima en UTC)
  si el nuevo monto excede el tope de S/1000 equivalente; si `p_moneda = 'USD'` y no hay tasa
  vigente, `PA010`; si pasa todas las validaciones, hace `upsert` sobre `saldos_demostracion`
  (`insert ... on conflict (investor_id, moneda) do update set saldo = saldo +
  excluded.saldo, updated_at = now()`) e inserta la fila en `recargas_saldo`; `revoke all ...
  from public, anon, authenticated` + `grant execute ... to authenticated` —
  contracts/saldo-demostracion.md
- [X] T022 [US3] Validar Historia 3 en local siguiendo `quickstart.md` §3 completo, incluida la
  prueba de concurrencia (5 recargas de S/300 en paralelo sobre la misma cuenta): confirmar que
  como máximo 3 se aceptan y que la suma nunca supera S/1000 exactos

**Checkpoint**: Historias 1, 2 y 3 funcionan de forma independiente — el inversionista ya puede
explorar, entender y tener saldo, aunque todavía no pueda aportar.

---

## Phase 6: User Story 4 - Aportar a un tramo de un pool (Priority: P1)

**Goal**: El inversionista cotiza un monto, confirma el aporte, y en la misma solicitud recibe el
resultado final (confirmado o fallido) con un comprobante — el pago se ejecuta en XLM real de
testnet desde su billetera hacia la custodia dedicada del pool.

**Independent Test**: Con saldo de demostración, billetera fondeada y un pool con cupo
disponible, cotizar un monto válido, confirmarlo antes de que expire, y verificar que el aporte
queda registrado, el saldo se descuenta, el pago llega a la custodia del pool en Horizon, y el
avance de fondeo se actualiza — todo en una sola solicitud síncrona.

### Implementation for User Story 4

- [X] T023 [US4] Extraer de `supabase/functions/provision-investor-wallet/index.ts` la lógica de
  generar un keypair (`Keypair.random()`), fondearlo vía Friendbot y guardarlo en Vault, a un
  módulo nuevo `supabase/functions/_shared/stellar-keypair.ts`, sin cambiar su comportamiento
  (Principio I: reutilizar en vez de duplicar antes de que exista un segundo lugar que la
  necesite)
- [X] T024 [US4] Refactorizar `supabase/functions/provision-investor-wallet/index.ts` para
  importar y usar `_shared/stellar-keypair.ts` en vez de su lógica inline (depende de T023;
  validar que el comportamiento documentado en
  `specs/20260919-131233-auth-perfil-usuario/contracts/provision-investor-wallet-function.md` no
  cambia)
- [X] T025 [P] [US4] Crear `supabase/migrations/0004_config_edge_functions_url.sql`: función
  `public.obtener_url_base_functions()` (`security definer`, `set search_path = ''`, mismo patrón
  que `obtener_shared_secret_webhook()`) que lee el secreto de Vault `edge_functions_base_url`;
  `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role`; y
  `create or replace function public.trigger_provision_wallet()` (mismo cuerpo que
  `0002_wallet_provisioning.sql`, salvo que `v_function_url` pasa de un literal hardcodeado a
  `obtener_url_base_functions() || '/provision-investor-wallet'`) — corrige el hallazgo de
  `research.md` §2 sin editar la migración `0002` ya aplicada
- [X] T026 [US4] Crear `supabase/migrations/0005_custodia_pools.sql`: función
  `public.aprovisionar_custodia_pool(pool_id uuid, custody_public_key text, custody_secret text)`
  (`security definer`, idéntico patrón idempotente que `aprovisionar_wallet_inversionista` — no
  hace nada si el pool ya tiene `custody_secret_id`), `revoke all ... from public, anon,
  authenticated` + `grant execute ... to service_role`; función trigger
  `public.trigger_provision_pool_custody()` (usa `obtener_url_base_functions() ||
  '/provision-pool-custody'`, T025) + su trigger `after insert on public.pools for each row`;
  `revoke all` sobre la función de trigger igual que `trigger_provision_wallet` (depende de T005,
  T025)
- [X] T027 [P] [US4] Crear `supabase/functions/provision-pool-custody/index.ts`: parsea el
  payload del Database Webhook, valida `x-webhook-secret` contra
  `obtener_shared_secret_webhook()`, genera+funda+guarda el keypair vía `_shared/stellar-
  keypair.ts` (T023), y llama a `aprovisionar_custodia_pool` — `200 { ok: true,
  custody_public_key }` o `500 { ok: false, error }` — contracts/provision-pool-custody-
  function.md (depende de T023, T026)
- [X] T028 [US4] Crear en `supabase/migrations/0008_cotizaciones_aportes.sql` la tabla
  `public.cotizaciones`: `id uuid primary key default gen_random_uuid()`;
  `investor_id uuid not null references auth.users(id)`;
  `pool_id uuid not null references public.pools(id)`;
  `tramo_id uuid not null references public.tramos(id)`;
  `monto_nominal numeric(14,2) not null check (monto_nominal > 0)`;
  `moneda public.moneda_soportada not null`;
  `tipo_cambio_aplicado numeric(18,7) not null`; `monto_xlm numeric(20,7) not null`;
  `generado_at timestamptz not null default now()`;
  `expira_at timestamptz not null default (now() + interval '5 minutes')`;
  `usada boolean not null default false`; `revoke all ... from anon, authenticated` + RLS sin
  políticas
- [X] T029 [US4] Crear en `0008_cotizaciones_aportes.sql` el enum `estado_aporte` (`'reservado'`,
  `'confirmado'`, `'revertido'`), el enum `motivo_reversion_aporte` (`'xlm_insuficiente'`,
  `'fallo_red_stellar'`, `'reserva_vencida'`, `'otro'`), y la tabla `public.aportes` con las
  columnas exactas de `data-model.md` (`investor_id`, `pool_id`, `tramo_id`, `cotizacion_id`
  FK, `idempotency_key uuid not null`, `monto_nominal`, `moneda`, `tipo_cambio_aplicado`,
  `xlm_pagados numeric(20,7)`, `estado public.estado_aporte not null default 'reservado'`,
  `tx_hash text`, `comprobante_simulado boolean not null default false`,
  `motivo_reversion public.motivo_reversion_aporte`, `reservado_at timestamptz not null default
  now()`, `expira_reserva_at timestamptz not null default (now() + interval '2 minutes')`,
  `confirmado_at`/`revertido_at timestamptz`); constraint `unique (investor_id,
  idempotency_key)` (garantía de no-duplicado a nivel de base de datos); índice parcial
  `aportes_reservados_vigencia on (estado, expira_reserva_at) where estado = 'reservado'`; índice
  `on (investor_id, estado)`; mismos `revoke`/RLS que T028
- [X] T030 [US4] Crear `public.cotizar_aporte(p_pool_id, p_tramo_tipo, p_monto)`
  (`security definer`, `set search_path = ''`, `set statement_timeout = '5s'`) en
  `0008_cotizaciones_aportes.sql`: valida rol inversionista (`PA008`) y billetera lista
  (`PA007`); resuelve el tramo (`PA012` si no existe) y su pool (`PA006` si no está `'abierto'`);
  valida `p_monto` múltiplo de `unidad_minima_aporte` (`PA001`, `mod(p_monto,
  unidad_minima_aporte) = 0`); lee `tipo_cambio_vigente(pools.moneda)` (`PA010` si no hay);
  valida saldo de demostración suficiente en `saldos_demostracion` para esa moneda (`PA002`) y
  cupo disponible del tramo (`PA003`, con `cupo_disponible` exacto en el error); inserta la fila
  en `cotizaciones` y devuelve el JSON de contracts/cotizar-aporte.md; `revoke all ... from
  public, anon, authenticated` + `grant execute ... to authenticated`
- [X] T031 [US4] Crear `public.reservar_aporte(p_cotizacion_id, p_investor_id,
  p_idempotency_key)` (`security definer`, `set search_path = ''`, `set statement_timeout =
  '5s'`) en `0008_cotizaciones_aportes.sql`, **solo `service_role`**: primero libera reservas
  vencidas (`update public.aportes set estado = 'revertido', motivo_reversion =
  'reserva_vencida' where estado = 'reservado' and expira_reserva_at < now()`, liberando su cupo
  en `tramos` y su saldo en `saldos_demostracion` antes de continuar — research.md §1, ciclo de
  vida del Aporte en data-model.md); si ya existe un aporte con esa `(investor_id,
  idempotency_key)`, devuelve su estado actual sin crear nada nuevo (FR-027); si no, valida la
  cotización (`PA004` expirada, `PA005` ya usada o de otro inversionista), descuenta
  atómicamente el cupo con el `update` condicional exacto de `research.md` §1
  (`update public.tramos set capital_comprometido = capital_comprometido + p_monto where id =
  p_tramo_id and capital_comprometido + p_monto <= capital_objetivo returning id`; `PA003` si
  `not found`), descuenta `saldos_demostracion.saldo` (`PA002` si insuficiente), marca
  `cotizaciones.usada = true`, e inserta el `aporte` en `estado = 'reservado'`; `revoke all ...
  from public, anon, authenticated` + `grant execute ... to service_role`
- [X] T032 [US4] Crear `public.confirmar_aporte(p_aporte_id uuid, p_tx_hash text, p_simulado
  boolean default false)` (`security definer`, `set search_path = ''`) en
  `0008_cotizaciones_aportes.sql`, **solo `service_role`**: `update public.aportes set estado =
  'confirmado', xlm_pagados = (select monto_xlm from cotizaciones where id = cotizacion_id),
  tx_hash = p_tx_hash, comprobante_simulado = p_simulado, confirmado_at = now() where id =
  p_aporte_id and estado = 'reservado'` — no vuelve a tocar cupo ni saldo (ya comprometidos en
  T031); `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role`
- [X] T033 [US4] Crear `public.revertir_aporte(p_aporte_id uuid, p_motivo
  public.motivo_reversion_aporte)` (`security definer`, `set search_path = ''`) en
  `0008_cotizaciones_aportes.sql`, **solo `service_role`**: libera el cupo en `tramos`
  (`capital_comprometido -= monto_nominal`) y devuelve el saldo en `saldos_demostracion`
  (`saldo += monto_nominal`) del aporte indicado, y `update public.aportes set estado =
  'revertido', motivo_reversion = p_motivo, revertido_at = now() where id = p_aporte_id and
  estado = 'reservado'`; `revoke all ... from public, anon, authenticated` + `grant execute ...
  to service_role`
- [X] T034 [P] [US4] Crear `supabase/functions/_shared/stellar-payment.ts`: función para
  consultar el balance XLM de una cuenta contra Horizon testnet, y función para construir/firmar/
  someter una operación `Payment` (XLM nativo) con un timeout interno de 25s
  (`AbortSignal.timeout(25_000)` o equivalente del SDK — research.md §3)
- [X] T035 [US4] Crear `supabase/functions/confirmar-aporte/index.ts` (`verify_jwt = true`):
  valida rol inversionista vía `perfiles`; llama a `reservar_aporte` (`service_role`) y responde
  de inmediato el fallo si esa llamada falla (sin tocar Stellar); si la reserva se creó, lee el
  secreto de la billetera del inversionista y `pools.custody_public_key`, chequea con
  `_shared/stellar-payment.ts` que `balance - monto_xlm >= 2` (reserva mínima) o revierte con
  `'xlm_insuficiente'` y responde `PA009`; somete el `Payment`; en éxito llama a
  `confirmar_aporte`, en fallo llama a `revertir_aporte` con `'fallo_red_stellar'` y responde
  `PA013`; responde siempre en la misma solicitud (FR-034) con el formato exacto de
  `contracts/confirmar-aporte-function.md` §Salida (depende de T031-T034)
- [X] T036 [US4] Validar Historia 4 en local siguiendo `quickstart.md` §4 completo (flujo feliz,
  doble envío con el mismo `idempotency_key`, y cada caso límite: `PA001`, `PA002`, `PA003`,
  `PA004`, `PA005`, `PA008`, `PA007`) y §5 (20 aportes simultáneos sobre un cupo de 1000 con
  unidad 100 → exactamente 10 exitosos, `tramos.capital_comprometido` nunca supera
  `capital_objetivo` — SC-002/SC-003)

**Checkpoint**: Historias 1 a 4 funcionan de forma independiente — el flujo central de la spec
(saldo → explorar → detalle → aportar) ya es demostrable de punta a punta.

---

## Phase 7: User Story 5 - Ver mis posiciones (Priority: P2)

**Goal**: El inversionista ve, en un solo lugar, todos sus aportes confirmados con su estado
actual; nunca ve los de otra cuenta.

**Independent Test**: Con datos de ejemplo que ya incluyen una posición previa, consultar
`mis_posiciones` de una cuenta demo y verificar que la información está completa y que ningún
inversionista ve posiciones de otra cuenta.

### Implementation for User Story 5

- [X] T037 [US5] Continuar `supabase/migrations/0008_cotizaciones_aportes.sql` (mismo archivo de
  T028-T033) agregando `public.mis_posiciones()` (`security definer`, `set search_path = ''`):
  devuelve, para cada `aportes` del `auth.uid()` actual con `estado = 'confirmado'`, pool
  (nombre, estado leído en vivo), tramo, monto nominal, moneda, XLM pagados, tipo de cambio
  aplicado y fecha de confirmación; array vacío si no hay ninguno, nunca error; `revoke all ...
  from public, anon, authenticated` + `grant execute ... to authenticated` —
  contracts/mis-posiciones.md
- [X] T038 [P] [US5] Crear `supabase/seed/02_saldos_y_posiciones_demo.sql`: saldo de
  demostración inicial para las 3 cuentas demo de inversionista (ids fijos de
  `00_auth_demo_local.sql`) vía `insert ... on conflict (investor_id, moneda) do nothing` sobre
  `saldos_demostracion`, y al menos una posición previa (fila en `cotizaciones` +
  `aportes` en `estado = 'confirmado'`, con `id` fijo y `on conflict (id) do nothing`) entre dos
  de esas cuentas sobre uno de los pools sembrados en `01_dominio_demo.sql` (FR-042; depende de
  T005, T006, T018, T028, T029, T013)
- [X] T039 [US5] Validar Historia 5 en local siguiendo `quickstart.md` §6: confirmar que
  `mis_posiciones` de `inversionista.demo1` incluye la posición previa del seed y el aporte
  confirmado en T036, y que `inversionista.demo2` no ve ninguna de esas filas (FR-036)

**Checkpoint**: Las 5 historias de usuario funcionan de forma independiente entre sí.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cierre de la feature — documentación, revisión de seguridad, y aplicación al
proyecto remoto.

- [X] T040 [P] Actualizar `README.md` con la arquitectura de esta feature (tablas de dominio,
  custodia por pool, funciones RPC y su tabla de códigos de error, las 2 Edge Functions nuevas y
  el helper compartido), mismo nivel de detalle que ya tiene la sección de la feature previa
- [X] T041 Revisar los Advisors de seguridad y performance del proyecto (vía el MCP de Supabase,
  solo lectura) tras aplicar todas las migraciones en local: confirmar que ninguna de las
  funciones internas (`reservar_aporte`, `confirmar_aporte`, `revertir_aporte`,
  `aprovisionar_custodia_pool`, `obtener_url_base_functions`) queda invocable vía
  `/rest/v1/rpc/...` por `anon`/`authenticated` — mismo tipo de hallazgo crítico que
  `research.md` de la feature previa encontró y corrigió; corregir cualquier `revoke` faltante
  antes de continuar (depende de T009-T037)
- [X] T042 Aplicar `supabase db push` (migraciones `0003`-`0009`) y `supabase functions deploy`
  (las 3 Edge Functions) contra el proyecto remoto vinculado (`qqpozotcrxfukkwcoget`); crear el
  secreto de Vault `edge_functions_base_url` apuntando a la URL de producción si no existe ya
  (T025); aplicar `supabase/seed/01_dominio_demo.sql` y `02_saldos_y_posiciones_demo.sql` vía
  conexión directa (`psql`), **nunca** `supabase/seed/00_auth_demo_local.sql` ni `db reset
  --linked`/`--include-seed` — quickstart.md §7 (depende de T041)
- [X] T043 Regresión final de punta a punta contra el proyecto remoto siguiendo `quickstart.md`
  completo (§1 a §6, incluida la prueba de 20 aportes simultáneos) con las 3 cuentas demo reales
  (depende de T042). **Nota de alcance** (decisión explícita del usuario al ejecutar esta tarea):
  se corrió §2, §4 (cotizar/confirmar/doble envío/casos límite) y §6 contra remoto con las 3
  cuentas demo reales, incluyendo un aporte real confirmado en Stellar testnet verificado de forma
  independiente en Horizon. Se **omitieron** a propósito contra remoto el agotamiento completo del
  tope diario de recarga (§3) y los 20 aportes simultáneos (§5), porque consumirían saldo/cupo
  real de las cuentas demo antes de la presentación del hackathon; ambos escenarios ya quedaron
  validados exhaustivamente en local (ver T022, T041 y research.md §6).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias — puede iniciar de inmediato.
- **Foundational (Phase 2)**: depende de Setup — BLOQUEA las 5 historias de usuario.
- **Historias de usuario (Phase 3-7)**: todas dependen de Foundational.
  - US2 depende de que exista el archivo `0009_catalogo_consultas.sql` de US1 (T011) porque
    `detalle_pool` se agrega al mismo archivo.
  - US4 depende de que US1 (T005, pools) y Foundational (T010, tipo de cambio) existan; también
    reutiliza el helper de wallet de US1 de la feature previa (T023-T024).
  - US5 depende de que US3 (`saldos_demostracion`, T018) y US4 (`aportes`, T028-T029) existan —
    tanto por su función (`mis_posiciones`, mismo archivo `0008`) como por su seed
    (T038, que referencia ambas tablas).
- **Polish (Phase 8)**: depende de que todas las historias que se quieran entregar estén
  completas.

### User Story Dependencies

- **US1 (P1)**: puede empezar apenas termina Foundational — sin dependencia de otras historias.
- **US2 (P1)**: depende del archivo creado por US1 (T011), pero no de que US1 haya terminado su
  seed (T013) para escribir el código de `detalle_pool`.
- **US3 (P1)**: puede empezar apenas termina Foundational — sin dependencia de código de US1/US2
  (sí depende de `tipo_cambio_vigente`, ya en Foundational).
- **US4 (P1)**: la historia más grande — depende de Foundational, de `pools` (US1) para la
  custodia, y reutiliza el patrón de wallet de la feature previa.
- **US5 (P2)**: depende de US3 y US4 completas (tablas `saldos_demostracion` y `aportes`).

### Parallel Opportunities

- T001/T002 (Setup) en paralelo entre sí.
- T010 (tipo de cambio) puede avanzar en paralelo con T004-T009 una vez exista T003 (enums).
- T013 (seed de dominio) puede avanzar en paralelo con T011-T012 (función `catalogo_pools`) —
  ambos solo dependen de Foundational.
- T025 (fix de URL de webhook) y T027 (Edge Function de custodia) pueden avanzar en paralelo con
  T028-T033 (tablas y funciones de cotización/aporte) — archivos distintos.
- T034 (`_shared/stellar-payment.ts`) puede avanzar en paralelo con T028-T033.
- T038 (seed de posiciones) puede avanzar en paralelo con T037 una vez existan T018 y T028-T029.
- T040 (README) puede avanzar en paralelo con T041 (Advisors).

---

## Parallel Example: inicio de User Story 4

```bash
# En Historia 4, el helper compartido y el fix de la URL del webhook pueden avanzar juntos:
Task: "Extraer _shared/stellar-keypair.ts desde provision-investor-wallet/index.ts"
Task: "Crear supabase/migrations/0004_config_edge_functions_url.sql"

# Una vez existe el helper, la Edge Function de custodia y el helper de pago avanzan en paralelo:
Task: "Crear supabase/functions/provision-pool-custody/index.ts"
Task: "Crear supabase/functions/_shared/stellar-payment.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 solamente)

1. Completar Fase 1: Setup.
2. Completar Fase 2: Foundational (CRÍTICO — bloquea todas las historias).
3. Completar Fase 3: Historia 1 (explorar y comparar pools).
4. **DETENERSE Y VALIDAR**: correr `quickstart.md` §1-2 de forma independiente.
5. Ya es demostrable: catálogo de pools reales con datos de ejemplo, filtrable y ordenable.

### Incremental Delivery

1. Setup + Foundational → esquema de dominio y tipo de cambio listos.
2. Historia 1 → validar independientemente → primer hito demostrable (MVP).
3. Historia 2 → validar independientemente → el inversionista ya entiende qué compra.
4. Historia 3 → validar independientemente → el inversionista ya tiene saldo con qué invertir.
5. Historia 4 → validar independientemente → **flujo central completo de la spec**
   (saldo → explorar → detalle → aportar), incluida la prueba de concurrencia crítica (SC-002).
6. Historia 5 → validar independientemente → cierra el ciclo de confianza del primer aporte.
7. Cada historia suma valor sin romper las anteriores.

### Team Strategy (equipo de 3)

Dado que Historia 4 concentra la mayor parte del trabajo nuevo (2 Edge Functions, la corrección
del webhook de wallet, y 6 funciones RPC de aporte), tiene sentido que una persona lleve
Foundational + Historia 4 de punta a punta mientras otra construye Historias 1 y 2 (catálogo y
detalle, que comparten el mismo archivo de migración) y la tercera construye Historia 3 (saldo,
completamente independiente) y prepara Historia 5 (posiciones) en cuanto Historia 4 tenga la
tabla `aportes` lista.

---

## Notes

- [P] = archivos distintos, sin dependencias pendientes entre sí.
- [Story] mapea cada tarea a su historia de usuario para trazabilidad.
- No hay tareas de frontend/UI — esta feature termina en la capa de API/backend (ver spec.md →
  Fuera de Alcance).
- Sin tests automatizados (Principio I); cada historia cierra con una tarea de validación manual
  contra `quickstart.md`, primero siempre en local (Docker) antes de tocar el proyecto remoto.
- Todo objeto de Supabase (tablas, RLS, triggers, funciones, los 2 Database Webhooks) se crea
  como archivo SQL versionado bajo `supabase/migrations/` — nunca desde el Dashboard
  (Principio VII). El MCP de Supabase se usa en esta feature solo para lectura/Advisors (T041),
  nunca para aplicar cambios de esquema.
- T025 corrige un hallazgo de la feature previa (URL de webhook hardcodeada a producción) sin
  editar la migración `0002` ya aplicada — se hace vía `CREATE OR REPLACE FUNCTION` en una
  migración nueva, patrón estándar para corregir un objeto ya desplegado.
- Hacer commit después de cada tarea o grupo lógico de tareas.
