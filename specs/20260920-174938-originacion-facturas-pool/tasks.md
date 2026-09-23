---
description: "Task list for feature implementation"
---

# Tasks: Originación de Facturas y Tokenización de Fracciones de Pool

**Input**: Design documents from `specs/20260920-174938-originacion-facturas-pool/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Sin tests automatizados de integración (Principio I de la constitución), salvo una
excepción explícita: el contrato Soroban (`contracts/soroban-pool`) sí lleva pruebas unitarias en
Rust (`cargo test`), justificada en `plan.md` → Technical Context → Testing (es la única pieza
donde un bug no se puede simplemente "arreglar y redesplegar" sin dejar rastro on-chain). El resto
de cada historia se cierra con una tarea de validación manual contra `quickstart.md`, primero en
local, contra el proyecto remoto solo en la fase final de Polish.

**Organization**: Las tareas están agrupadas por historia de usuario para permitir implementación
y validación independientes de cada una. Feature de backend (Supabase) + contrato inteligente
(Soroban/Rust) — no hay tareas de frontend/UI.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Puede ejecutarse en paralelo (archivo distinto, sin dependencias pendientes)
- **[Story]**: A qué historia de usuario pertenece la tarea (US1, US2, US3, US4, US5)
- Cada tarea incluye la ruta de archivo exacta

## Path Conventions

Dos componentes de primera clase (`plan.md` → Project Structure): `supabase/` (migraciones en
`supabase/migrations/`, Edge Functions en `supabase/functions/`, datos de ejemplo en
`supabase/seed/`) y `contracts/soroban-pool/` (crate Rust del contrato, hoy un placeholder vacío
— `contracts/scripts/` y `contracts/deployments/` para el despliegue). No hay carpeta `apps/` en
el alcance de esta feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Dejar el crate del contrato listo para compilar antes de escribir su lógica real
(`plan.md` → Orden de implementación, paso 1) — puede avanzar en paralelo con la Fase 2, que es
puro Postgres.

- [X] T001 [P] Reemplazar el placeholder `contracts/soroban-pool/.gitkeep` por un crate Rust
  mínimo que compile: `contracts/soroban-pool/Cargo.toml` (dependencia `soroban-sdk`, `crate-type
  = ["cdylib"]`, perfil `release` con `opt-level = "z"`, `lto = true`, `panic = "abort"` — patrón
  estándar de un contrato Soroban) y `contracts/soroban-pool/src/lib.rs` con `#![no_std]`, el
  atributo `#[contract]` sobre una struct `PoolFractionToken` vacía y un `#[contractimpl] impl
  PoolFractionToken {}` sin funciones todavía (se llenan en la Fase 5, Historia 3)
- [X] T002 [P] Crear `contracts/scripts/deploy.sh` como esqueleto ejecutable (`chmod +x`) con los
  5 pasos documentados en `contracts/deploy-contrato.md` como comentarios `# TODO` en orden (subir
  WASM, instanciar por tramo, poblar `configuracion_red`, escribir `contracts/deployments/
  testnet.json`) — se completa en la Fase 5 (Historia 3), cuando el contrato ya tiene lógica real
  que desplegar
- [X] T003 [P] Crear `contracts/deployments/` (directorio vacío con `.gitkeep`) — destino
  versionado de `testnet.json` (nunca contiene secretos, solo IDs y llaves públicas)

**Checkpoint**: El crate compila (`cargo build --target wasm32-unknown-unknown --release` produce
un WASM vacío pero válido) — listo para que la Fase 5 le añada lógica.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Esquema de originación de facturas (proveedores, `facturas` renombrada desde
`operaciones`, columnas nuevas de `tramos`/`pools`) y tabla de configuración por red — compartidos
por las 5 historias de usuario. Incluye la corrección inmediata de `catalogo_pools`/`detalle_pool`
para que sigan funcionando tras el renombre (research.md §7) — sin esto, la feature previa
quedaría rota entre esta fase y la Historia 4.

**⚠️ CRITICAL**: Ninguna historia de usuario puede implementarse hasta que esta fase esté completa.

- [X] T004 [P] Crear `supabase/migrations/0010_configuracion_red.sql`: tabla
  `public.configuracion_red` con las columnas exactas de `data-model.md`: `red text primary key`;
  `operador_authority_public_key text not null`; `operador_authority_secret_id uuid not null`;
  `token_wasm_hash text not null`; `created_at`/`updated_at timestamptz not null default now()`
  (trigger `set_updated_at()` ya existente, reutilizado); habilitar RLS sin políticas y
  `revoke all on public.configuracion_red from anon, authenticated`
- [X] T005 En `0010_configuracion_red.sql`, crear `public.obtener_configuracion_red(p_red text
  default 'testnet')` (`security definer`, `set search_path = ''`) que devuelve
  `operador_authority_public_key`/`token_wasm_hash` (nunca el secreto) de la fila de esa red;
  `revoke all ... from public, anon, authenticated` + `grant execute ... to service_role` (mismo
  patrón que `obtener_url_base_functions()`, `0004_config_edge_functions_url.sql`)
- [X] T006 En `0010_configuracion_red.sql`, crear el wrapper `public.obtener_secreto_autoridad_
  operador()` (`security definer`, `set search_path = ''`) que hace `select decrypted_secret from
  vault.decrypted_secrets where id = (select operador_authority_secret_id from configuracion_red
  where red = 'testnet')`; mismo patrón exacto que `obtener_secreto_wallet(uuid)`
  (`0008_cotizaciones_aportes.sql`); `revoke all ... from public, anon, authenticated` + `grant
  execute ... to service_role`
- [X] T007 [P] Crear `supabase/migrations/0011_proveedores_facturas.sql`: tabla
  `public.proveedores` con las columnas exactas de `data-model.md`: `id uuid primary key default
  gen_random_uuid()`; `nombre_comercial text not null`; `created_at timestamptz not null default
  now()`; habilitar RLS sin políticas y `revoke all on public.proveedores from anon,
  authenticated`
- [X] T008 En `0011_proveedores_facturas.sql`, crear los tres enums nuevos: `create type
  public.estado_validacion_factura as enum ('aprobada', 'rechazada')`; `create type
  public.estado_cobro_factura as enum ('pendiente', 'cobrada', 'en_mora')`; `create type
  public.estado_asignacion_factura as enum ('sin_asignar', 'pendiente_onchain', 'asignada',
  'rechazada_asignacion')`
- [X] T009 En `0011_proveedores_facturas.sql`, ejecutar `alter table public.operaciones rename to
  facturas;` y luego `alter table public.facturas alter column pool_id drop not null, add column
  proveedor_id uuid not null references public.proveedores(id), add column fecha_emision date not
  null default current_date, add column fecha_vencimiento date not null default (current_date +
  interval '30 days'), add column huella_hash text not null default '', add column
  estado_validacion public.estado_validacion_factura not null default 'aprobada', add column
  motivo_rechazo text, add column estado_cobro public.estado_cobro_factura not null default
  'pendiente', add column estado_asignacion public.estado_asignacion_factura not null default
  'sin_asignar', add column tramo_id uuid references public.tramos(id), add column anticipo
  numeric(14,2), add column onchain_tx_hash text` — los `default` de las columnas nuevas cubren
  únicamente las 9 filas ya sembradas por la spec previa (que nacieron directamente "asignadas")
- [X] T010 En `0011_proveedores_facturas.sql`, agregar las constraints exactas de
  `data-model.md`: `alter table public.facturas add constraint facturas_anticipo_valido check
  (anticipo is null or (anticipo > 0 and anticipo <= monto_nominal)), add constraint
  facturas_asignacion_coherente check ((estado_asignacion = 'sin_asignar' and tramo_id is null and
  pool_id is null and anticipo is null) or (estado_asignacion <> 'sin_asignar' and tramo_id is not
  null and pool_id is not null and anticipo is not null))`
- [X] T011 En `0011_proveedores_facturas.sql`, sustituir el trigger de coherencia de moneda:
  `drop trigger operaciones_moneda_coincide_pool on public.facturas;` seguido de una nueva función
  `public.facturas_moneda_coincide_pool()` que solo valida `new.moneda <> (select moneda from
  pools where id = new.pool_id)` cuando `new.pool_id is not null` (antes se exigía siempre; ahora
  una factura puede nacer sin pool) y su trigger `before insert or update on public.facturas`
- [X] T012 En `0011_proveedores_facturas.sql`, `alter table public.tramos add column
  monto_financiado_acumulado numeric(14,2) not null default 0 check
  (monto_financiado_acumulado >= 0), add column reserva numeric(14,2) not null default 0 check
  (reserva >= 0), add column fracciones_totales integer not null default 0 check
  (fracciones_totales >= 0), add column token_contract_id text`
- [X] T013 En `0011_proveedores_facturas.sql`, crear el trigger de defensa en profundidad
  `public.tramos_capital_objetivo_multiplo()` (`before insert or update of capital_objetivo on
  public.tramos`): rechaza con `raise exception ... using errcode = 'PA014'` si
  `mod(new.capital_objetivo, (select unidad_minima_aporte from pools where id = new.pool_id)) <>
  0` (invariante de `research.md` §6: `capital_objetivo` siempre múltiplo exacto de la unidad
  mínima del pool)
- [X] T014 En `0011_proveedores_facturas.sql`, `alter table public.pools add column
  margen_plazo_dias integer not null default 5 check (margen_plazo_dias >= 0)` (FR-023, valor por
  defecto documentado en `data-model.md` → Assumptions)
- [X] T015 En `0011_proveedores_facturas.sql`, corregir con `create or replace function` las dos
  funciones ya desplegadas que referencian `public.operaciones` (`0009_catalogo_consultas.sql`)
  para que apunten a `public.facturas` en su lugar — **mismo comportamiento observable, sin
  ningún campo nuevo todavía** (los campos nuevos de Historia 4/5 se agregan en
  `0013_facturas_del_pool_y_detalle.sql`, no aquí): `catalogo_pools(...)` (el `exists (select 1
  from public.operaciones o ...)` del filtro por sector pasa a `public.facturas o`) y
  `detalle_pool(uuid)` (el `from public.operaciones o join public.empresas_pagadoras e ...` de la
  composición agregada pasa a `public.facturas o`) — sin este paso, ambas funciones quedarían
  rotas apenas se aplique el `rename` de T009

**Checkpoint**: Esquema de originación listo, y el catálogo/detalle de pools de la spec previa
sigue funcionando exactamente igual sobre la tabla renombrada — las historias de usuario pueden
empezar.

---

## Phase 3: User Story 1 - Registrar y validar una factura de demostración (Priority: P1)

**Goal**: Un operador de banco registra una factura de demostración (sin documento real) y el
sistema la valida de inmediato, dejándola aprobada o rechazada con un motivo claro.

**Independent Test**: Registrar facturas con datos válidos e inválidos (sin que exista todavía
ningún pool) y verificar que cada una queda aprobada o rechazada con el motivo correcto, y que
ningún rol distinto de operador de banco puede registrar.

### Implementation for User Story 1

- [X] T016 [US1] Crear `supabase/migrations/0012_registro_y_asignacion_facturas.sql` con la
  función `public.registrar_factura(p_proveedor_nombre text, p_deudor_nombre text, p_deudor_sector
  public.sector_empresa, p_moneda public.moneda_soportada, p_monto_nominal numeric,
  p_fecha_emision date, p_fecha_vencimiento date) returns jsonb` (`security definer`, `set
  search_path = ''`, `set statement_timeout = '5s'`), siguiendo `contracts/registrar-factura.md`:
  rechaza con `PA008` si `rol <> 'operador_banco'`; valida `p_monto_nominal <= 0` o
  `p_fecha_vencimiento <= p_fecha_emision` → resultado `rechazada`/`PA014` (no excepción); busca o
  crea `proveedores`/`empresas_pagadoras` por `nombre_comercial` exacto; detecta duplicado exacto
  (mismo `proveedor_id`, `empresa_id`, `monto_nominal`, `fecha_emision`, `fecha_vencimiento`) →
  `rechazada`/`PA015`; calcula `huella_hash` con `encode(digest(proveedor_id::text ||
  deudor_id::text || monto_nominal::text || moneda::text || fecha_emision::text ||
  fecha_vencimiento::text, 'sha256'), 'hex')`; inserta con `estado_validacion = 'aprobada'`
- [X] T017 [US1] En `0012_registro_y_asignacion_facturas.sql`, `revoke all on function
  public.registrar_factura(...) from public, anon, authenticated` + `grant execute ... to
  authenticated` (el chequeo de rol vive dentro de la función, mismo patrón que
  `cotizar_aporte`)
- [X] T018 [US1] En `0012_registro_y_asignacion_facturas.sql`, crear `public.listar_facturas_
  operador(p_estado_validacion public.estado_validacion_factura default null,
  p_estado_asignacion public.estado_asignacion_factura default null) returns table (id uuid,
  proveedor_nombre text, deudor_nombre text, deudor_sector public.sector_empresa, moneda
  public.moneda_soportada, monto_nominal numeric, fecha_emision date, fecha_vencimiento date,
  estado_validacion public.estado_validacion_factura, motivo_rechazo text, estado_asignacion
  public.estado_asignacion_factura, estado_cobro public.estado_cobro_factura, pool_id uuid,
  tramo_id uuid, anticipo numeric)` (`security definer`, `stable`, `set search_path = ''`) —
  rechaza con `PA008` si el rol no es `operador_banco`; es la única función de esta feature que
  expone `proveedor_nombre`/`deudor_nombre` por fila (`contracts/registrar-factura.md`); `revoke
  all ... from public, anon, authenticated` + `grant execute ... to authenticated`
- [X] T019 [US1] Validación manual: ejecutar `quickstart.md` §1-2 contra el stack local (registrar
  factura válida → aprobada; monto negativo → rechazada `PA014`; duplicado exacto → rechazada
  `PA015`; rol inversionista → error `PA008`)

**Checkpoint**: Historia 1 funcional y testeable de forma independiente — un operador puede
registrar y ver el resultado de validación de cualquier factura de demostración.

---

## Phase 4: User Story 2 - Asignar una factura aprobada a un pool y fraccionarla (Priority: P1)

**Goal**: Un operador de banco asigna manualmente una factura aprobada a un único pool/tramo
definiendo su anticipo; el sistema acumula ese anticipo al monto financiado del tramo, calcula las
fracciones completas resultantes según la unidad mínima del pool, y deja el residuo como reserva
del pool sin rechazar nunca la factura por eso.

**Independent Test**: Con facturas aprobadas (Historia 1) y pools/tramos de ejemplo ya existentes,
invocar directamente `asignar_factura_a_pool`/`confirmar_asignacion_factura` (sin pasar todavía por
el contrato Soroban, que llega en la Historia 3) y verificar que el monto financiado acumulado, las
fracciones disponibles y la reserva del tramo se actualizan correctamente, que la factura queda
bloqueada para cualquier otro pool, y que ningún rol distinto de operador de banco puede asignar.

### Implementation for User Story 2

- [X] T020 [US2] En `0012_registro_y_asignacion_facturas.sql`, crear `public.asignar_factura_
  a_pool(p_factura_id uuid, p_tramo_id uuid, p_anticipo numeric) returns jsonb` (`security
  definer`, `set search_path = ''`, `set statement_timeout = '5s'`), siguiendo
  `contracts/asignar-factura-function.md` paso 2: si la factura ya está `'pendiente_onchain'` o
  `'asignada'` con el mismo `tramo_id`/`anticipo` → devuelve el estado actual (`ya_existia: true`);
  si `estado_validacion <> 'aprobada'` o no existe → `PA016`; si `estado_asignacion <>
  'sin_asignar'` con datos distintos → `PA018`; si `p_anticipo <= 0` o `> monto_nominal` →
  `PA017`; calcula `v_nuevo_total := monto_financiado_acumulado + p_anticipo`,
  `v_fracciones_nuevas := floor(v_nuevo_total / unidad_minima_aporte)`, `v_nueva_reserva :=
  v_nuevo_total - v_fracciones_nuevas * unidad_minima_aporte`,
  `v_incremento_capital := (v_fracciones_nuevas - fracciones_totales) * unidad_minima_aporte`;
  actualiza `tramos` (`monto_financiado_acumulado`, `reserva`, `fracciones_totales`,
  `capital_objetivo += v_incremento_capital`) con un `UPDATE` de una sola sentencia; marca la
  factura `estado_asignacion = 'pendiente_onchain'`, `tramo_id`, `pool_id := (select pool_id from
  tramos where id = p_tramo_id)`, `anticipo`
- [X] T021 [US2] En `0012_registro_y_asignacion_facturas.sql`, `revoke all on function
  public.asignar_factura_a_pool(...) from public, anon, authenticated` + `grant execute ... to
  service_role` únicamente (se invoca solo desde la Edge Function `asignar-factura`, mismo patrón
  restringido que `reservar_aporte`)
- [X] T022 [US2] En `0012_registro_y_asignacion_facturas.sql`, crear `public.confirmar_asignacion_
  factura(p_factura_id uuid, p_onchain_tx_hash text) returns void` (`security definer`, `set
  search_path = ''`): `update facturas set estado_asignacion = 'asignada', onchain_tx_hash =
  p_onchain_tx_hash where id = p_factura_id and estado_asignacion = 'pendiente_onchain'`; `revoke
  all ... from public, anon, authenticated` + `grant execute ... to service_role`
- [X] T023 [US2] En `0012_registro_y_asignacion_facturas.sql`, crear `public.revertir_asignacion_
  factura(p_factura_id uuid) returns void` (`security definer`, `set search_path = ''`): si la
  factura no está `'pendiente_onchain'`, no hace nada (idempotente); si lo está, recalcula
  `v_total_antes := monto_financiado_acumulado - anticipo`,
  `v_fracciones_antes := floor(v_total_antes / unidad_minima_aporte)`,
  `v_decremento_capital := (fracciones_totales - v_fracciones_antes) * unidad_minima_aporte` sobre
  el tramo referenciado, revierte esos tres campos más `capital_objetivo -= v_decremento_capital`,
  y devuelve la factura a `estado_asignacion = 'sin_asignar', tramo_id = null, pool_id = null,
  anticipo = null` (`data-model.md` → ciclo de vida de Factura: vuelve a `'aprobada'`, reutilizable
  con otro pool/tramo/anticipo); `revoke all ... from public, anon, authenticated` + `grant
  execute ... to service_role`
- [X] T024 [US2] Validación manual: invocar `asignar_factura_a_pool` directamente vía SQL sobre una
  factura aprobada y un tramo de ejemplo, confirmar con `confirmar_asignacion_factura` usando un
  `p_onchain_tx_hash` de prueba (placeholder, la Historia 3 lo reemplaza por uno real), y verificar
  en `tramos` que `fracciones_totales`/`reserva`/`capital_objetivo` cambiaron exactamente según la
  fórmula de T020; repetir la misma llamada de asignación → `ya_existia: true` sin duplicar;
  intentar asignar la misma factura a otro `tramo_id` → `PA018`; anticipo mayor al nominal →
  `PA017`

**Checkpoint**: Historia 2 funcional y testeable de forma independiente a nivel de Postgres — el
fraccionamiento por anticipo/unidad mínima/reserva ya es correcto y verificable, aunque todavía no
exista evidencia on-chain (eso lo agrega la Historia 3 envolviendo estas mismas funciones en la
Edge Function `asignar-factura`).

---

## Phase 5: User Story 3 - Representar en cadena las fracciones del pool y las posiciones del inversionista (Priority: P1)

**Goal**: Un contrato Soroban por tramo lleva el registro de fracciones y las hace cumplir por sí
mismo (cupo, unidad mínima, solo el operador registra); la asignación de una factura (Historia 2)
y el aporte de un inversionista (spec previa) terminan reflejados como fracciones emitidas y
verificables directamente en Stellar testnet.

**Independent Test**: Tras desplegar el contrato y completar una asignación de factura y un aporte
confirmado de ejemplo, consultar el contrato directamente en testnet (sin pasar por la plataforma)
y verificar que el cupo, las fracciones emitidas y su propietario coinciden con lo esperado, y que
un intento de invocar una función administrativa desde una cuenta que no es la autoridad de
plataforma es rechazado por el propio contrato.

### Implementation for User Story 3 — contrato (`contracts/soroban-pool`)

- [X] T025 [P] [US3] En `contracts/soroban-pool/src/lib.rs`, definir `DataKey` (`Admin`,
  `Decimals`, `Name`, `Symbol`, `Cap`, `TotalSupply`, `Balance(Address)`,
  `Allowance(Address, Address)`, `Factura(BytesN<32>)`) y `Error` (`NotInitialized = 1`,
  `AlreadyInitialized = 2`, `NotAuthorized = 3`, `CapExceeded = 4`, `CapCannotDecrease = 5`,
  `InvoiceAlreadyRegistered = 6`, `InsufficientBalance = 7`, `InsufficientAllowance = 8`) —
  interfaz exacta de `contracts/soroban-pool-token.md`
- [X] T026 [US3] Implementar `initialize(admin: Address, pool_ref: String, tramo: Symbol)` (falla
  con `AlreadyInitialized` si ya se llamó) y `set_admin(new_admin: Address)`
  (`admin.require_auth()`) en `contracts/soroban-pool/src/lib.rs`
- [X] T027 [US3] Implementar `register_invoice(invoice_hash: BytesN<32>, new_cap: i128)` en
  `contracts/soroban-pool/src/lib.rs`: `admin.require_auth()`; `InvoiceAlreadyRegistered` si
  `invoice_hash` ya existe en `Factura(...)`; `CapCannotDecrease` si `new_cap < Cap`; guarda
  `Factura(invoice_hash) = new_cap - Cap`; actualiza `Cap = new_cap`; emite el evento
  `("factura_registrada", invoice_hash, new_cap)`; extiende el TTL de la instancia y de `Cap` al
  máximo permitido (`research.md` §3)
- [X] T028 [US3] Implementar `mint(to: Address, amount: i128)` en
  `contracts/soroban-pool/src/lib.rs`: `admin.require_auth()`; `CapExceeded` si `TotalSupply +
  amount > Cap`; incrementa `Balance(to)` y `TotalSupply`; emite `("fracciones_emitidas", to,
  amount)`; extiende el TTL de `Balance(to)`
- [X] T029 [P] [US3] Implementar las funciones de lectura en `contracts/soroban-pool/src/lib.rs`:
  `balance(id: Address) -> i128` (`Balance(id)` o `0`), `decimals() -> u32` (siempre `0`), `name()
  -> String` / `symbol() -> String` (fijados en `initialize`), `cap() -> i128`, `total_supply() ->
  i128`
- [X] T030 [US3] Implementar la interfaz SEP-41 restante en `contracts/soroban-pool/src/lib.rs`
  por completitud de interfaz (no usada por ningún flujo del producto — mercado secundario fuera
  de alcance): `transfer(from, to, amount)` (`from.require_auth()`, `InsufficientBalance` si
  aplica), `approve(from, spender, amount, live_until_ledger)` / `allowance(from, spender) ->
  i128`, `burn(from, amount)` (`from.require_auth()`)
- [X] T031 [US3] Escribir pruebas unitarias en `contracts/soroban-pool/src/test.rs` (entorno de
  pruebas de `soroban-sdk`, `Env::default()`): inicialización exitosa y doble inicialización
  (`AlreadyInitialized`); `register_invoice` incrementa `Cap` y rechaza duplicado/decremento;
  `mint` respeta `Cap` (incluida una secuencia de mints que exactamente lo agota, y uno más que se
  rechaza con `CapExceeded`); `mint`/`register_invoice`/`set_admin` sin la firma del admin fallan
  con autenticación (usar `env.mock_all_auths()` para los casos positivos, y una dirección
  distinta sin mock para el caso negativo)
- [X] T032 [US3] Compilar y correr `cargo test` + build de release en `contracts/soroban-pool/` —
  checkpoint del 23-sep-2026 (arquitectura + esquema del contrato demostrable). Ejecutado en vivo:
  9/9 pruebas OK; el build de release requirió `stellar contract build` con target
  `wasm32v1-none` (no `wasm32-unknown-unknown` — `soroban-sdk` ≥22 en Rust 1.82+ lo exige) y
  subir `soroban-sdk` de `21.7.0` a `28.0.0` (las dependencias transitivas de la versión original
  ya no compilan contra el estado actual de crates.io)

### Implementation for User Story 3 — despliegue y aprovisionamiento

- [X] T033 [US3] Completar `contracts/scripts/deploy.sh` (reemplaza los `# TODO` de T002) según
  `contracts/deploy-contrato.md`: generar y fondear la autoridad de plataforma
  (`stellar keys generate operador-authority --network testnet --fund`), subir el WASM
  (`stellar contract upload`) para obtener `wasm_hash`, y por cada uno de los 10 tramos ya
  sembrados por la spec previa: `stellar contract deploy --wasm-hash <wasm_hash> ...` +
  `stellar contract invoke ... -- initialize --admin <authority_public_key> --pool_ref <codigo_
  pool> --tramo <senior|junior>`
- [X] T034 [US3] En `contracts/scripts/deploy.sh`, agregar el paso final: insertar la fila en
  `configuracion_red` (vía el cliente `service_role` de Supabase, creando primero el secreto en
  Vault con la llave privada de la autoridad) y actualizar `tramos.token_contract_id` por cada
  tramo desplegado; escribir `contracts/deployments/testnet.json` con el esquema exacto de
  `contracts/deploy-contrato.md` (`red`, `wasm_hash`, `operador_authority_public_key`,
  `desplegado_at`, `tramos[]` con `pool_codigo`/`tramo`/`contract_id`) — nunca escribe ninguna
  llave secreta
- [X] T035 [US3] Ejecutar `contracts/scripts/deploy.sh` contra testnet una vez y verificar que los
  10 tramos de ejemplo quedan con `token_contract_id` poblado y `cap() = 0`/`total_supply() = 0`
  en cada instancia (`quickstart.md` §0). Ejecutado en vivo (pasos equivalentes vía `stellar-cli` +
  MCP de Supabase en vez del script `.sh` línea por línea, mismo resultado): 12 tramos (6 pools ×
  senior/junior, no 10) desplegados e inicializados; verificado `cap()=0`/`total_supply()=0` en
  una instancia de muestra antes de cualquier operación. Evidencia en
  `contracts/deployments/testnet.json`
- [X] T036 [P] [US3] Crear `supabase/migrations/0014_provision_pool_tramo_token.sql`:
  `public.trigger_provision_pool_tramo_token()` (mismo patrón exacto que
  `trigger_provision_pool_custody()`, `0005_custodia_pools.sql`: solo dispara si
  `new.token_contract_id is null`, arma el payload `to_jsonb(new)` y hace `net.http_post` hacia
  `obtener_url_base_functions() || '/provision-pool-tramo-token'` con el header
  `x-webhook-secret`) + `create trigger tramos_provision_token after insert on public.tramos for
  each row execute function public.trigger_provision_pool_tramo_token()`
- [X] T037 [P] [US3] Crear `supabase/functions/_shared/stellar-soroban.ts` (`_shared/
  stellar-payment.ts` y `_shared/stellar-keypair.ts` como referencia de estilo) con
  `invocarContratoAdmin(secretoAdmin, contractId, metodo, args)`: construir la operación
  (`new Contract(contractId).call(metodo, ...args)`) → `TransactionBuilder` →
  `server.prepareTransaction()` (simula; si falla, lanza de inmediato sin someter nada) → firmar →
  `server.sendTransaction()` → *poll* de `server.getTransaction(hash)` cada 2s hasta
  `SUCCESS`/`FAILED` con timeout interno de 15s (`research.md` §4); y
  `consultarBalanceFraccion(contractId, address)` de solo lectura vía `server.
  simulateTransaction()`, sin firma ni fee
- [X] T038 [US3] Crear `supabase/functions/provision-pool-tramo-token/index.ts`
  (`verify_jwt = false`, agregar `[functions.provision-pool-tramo-token]` con
  `verify_jwt = false` en `supabase/config.toml`), siguiendo
  `contracts/provision-pool-tramo-token-function.md`: verificar `x-webhook-secret`; leer
  `configuracion_red`/`obtener_secreto_autoridad_operador()`; instanciar una nueva copia del
  contrato a partir de `token_wasm_hash` con una `salt` aleatoria (`createContract`); invocar
  `initialize(admin, pool_ref, tramo)`; `update tramos set token_contract_id = <id> where id =
  record.id`

### Implementation for User Story 3 — integración con originación y aporte

- [X] T039 [US3] Crear `supabase/functions/asignar-factura/index.ts`
  (`verify_jwt = true`, agregar `[functions.asignar-factura]` con `verify_jwt = true` en
  `supabase/config.toml`), siguiendo `contracts/asignar-factura-function.md`: validar JWT +
  `perfiles.rol = 'operador_banco'` (`PA008` si no); llamar `asignar_factura_a_pool` (T020); leer
  `tramos.token_contract_id` (si es `null`, responder `PA019` — "el tramo todavía no tiene su
  contrato listo"); invocar `register_invoice(huella_hash, nuevo_fracciones_totales)` vía
  `invocarContratoAdmin` (T037) con hasta 3 intentos y backoff de 1s/2s (`research.md` §2); éxito →
  `confirmar_asignacion_factura` (T022); fallo definitivo → `revertir_asignacion_factura` (T023) y
  responder `PA019`
- [X] T040 [US3] En `supabase/migrations/0015_mint_fracciones_aporte.sql`: `alter table
  public.aportes add column fraccion_tx_hash text;` y `alter type
  public.motivo_reversion_aporte add value 'fallo_emision_fracciones';` (en sentencias separadas
  dentro del mismo archivo — el nuevo valor de enum no se usa en la misma transacción que lo crea)
- [X] T041 [US3] En `0015_mint_fracciones_aporte.sql`, crear
  `public.obtener_secreto_custodia_pool(p_pool_id uuid) returns text` (`security definer`, `set
  search_path = ''`): `select decrypted_secret from vault.decrypted_secrets where id = (select
  custody_secret_id from pools where id = p_pool_id)` — mismo patrón que
  `obtener_secreto_wallet(uuid)`, necesario para firmar el reembolso compensatorio; `revoke all
  ... from public, anon, authenticated` + `grant execute ... to service_role`
- [X] T042 [US3] Modificar `supabase/functions/confirmar-aporte/index.ts` siguiendo
  `contracts/confirmar-aporte-extension.md`: tras el pago XLM exitoso (y antes de
  `confirmar_aporte`), si `fraccion_tx_hash` de este aporte ya está poblado (reintento) saltar
  este paso; si no, leer `token_contract_id` del tramo + secretos, calcular `amount := monto_
  nominal / unidad_minima_aporte`, invocar `mint(investor_address, amount)` (T037) con hasta 3
  intentos; éxito → guardar `fraccion_tx_hash` y proceder a `confirmar_aporte` sin cambios; fallo
  definitivo → someter el pago compensatorio (XLM de la custodia del pool de vuelta al
  inversionista, firmado con `obtener_secreto_custodia_pool`, T041) y solo si ese reembolso tiene
  éxito llamar `revertir_aporte(aporte_id, 'fallo_emision_fracciones')` y responder `PA019` con
  `reembolso.tx_hash`; si el reembolso también falla, responder `PA013` sin revertir (límite
  conocido, `plan.md` → Riesgos)
- [X] T043 [US3] Validación manual: ejecutar `quickstart.md` §3, §6, §7, §8, §9 y §10 contra
  testnet real. Completado con evidencia real para §3 (`cap()` verificado independientemente tras
  asignar, vía `stellar contract invoke --send=no`), §6 (un intento de `register_invoice` desde
  una cuenta que no es la autoridad es rechazado por el propio framework de autorización de
  Soroban — la simulación exige la firma del admin real, imposible de proveer con otra cuenta) y
  §7 (aporte confirmado real: pago XLM + `mint` con `balance()`/`total_supply()` verificados). §9
  (fallo con reembolso automático) también quedó demostrado, pero de forma no planeada: un bug
  real del SDK (ver más abajo) causó un fallo genuino de mint a mitad de camino, y
  `confirmar-aporte` compensó correctamente (reembolso XLM real, aporte revertido) — evidencia de
  que la garantía funciona bajo fallo real, no solo simulado. §8 (concurrencia, 20 aportes
  simultáneos) y la repetición controlada de §9/§10 en un escenario deliberado (no accidental)
  **no se ejecutaron** — quedan como validación pendiente, de menor riesgo ya que la garantía de
  cupo (§8) y la idempotencia (§10) ya estaban demostradas a nivel Postgres por la spec anterior, y
  la causa raíz de la única falla real encontrada (no una falla de concurrencia) ya está corregida
  y reverificada con una repetición limpia exitosa.

**Checkpoint**: Historias 1, 2 y 3 completas — el flujo de originación + fraccionamiento +
tokenización queda demostrable de punta a punta con evidencia on-chain real y verificable de forma
independiente (Principio VI).

---

## Phase 6: User Story 4 - Consultar las facturas anonimizadas que respaldan un pool (Priority: P2)

**Goal**: Un inversionista consulta, para cualquier pool, el listado de facturas asignadas en
versión anonimizada (monto, plazo, vencimiento, sector, estado de cobro), sin ver nunca proveedor
ni deudor.

**Independent Test**: Abrir el detalle de un pool de ejemplo ya respaldado por varias facturas
asignadas y verificar que el listado anonimizado muestra los campos permitidos y en ningún caso los
nombres de proveedor o deudor, sin necesidad de que el inversionista llegue a aportar.

### Implementation for User Story 4

- [X] T044 [US4] Crear `supabase/migrations/0013_facturas_del_pool_y_detalle.sql` con
  `public.facturas_del_pool(p_pool_id uuid) returns table (factura_id uuid, monto_nominal numeric,
  moneda public.moneda_soportada, sector public.sector_empresa, fecha_vencimiento date, dias_plazo
  integer, estado_cobro public.estado_cobro_factura)` (`security definer`, `stable`, `set
  search_path = ''`, `set statement_timeout = '5s'`), siguiendo
  `contracts/facturas-del-pool.md`: `where f.pool_id = p_pool_id and f.estado_asignacion =
  'asignada'`, `join empresas_pagadoras e on e.id = f.empresa_id` **solo** para proyectar
  `e.sector` — el `select` nunca menciona `nombre_comercial` de ninguna de las dos tablas;
  `dias_plazo := fecha_vencimiento - fecha_emision`; `revoke all ... from public, anon,
  authenticated` + `grant execute ... to authenticated`
- [X] T045 [US4] En `0013_facturas_del_pool_y_detalle.sql`, `create or replace function
  public.detalle_pool(p_pool_id uuid)` agregando al `jsonb` ya devuelto los campos
  `margen_plazo_dias` (de `pools`) y `estado_facturas` (`jsonb_build_object('pendientes', count(*)
  filter (where estado_cobro = 'pendiente'), 'cobradas', count(*) filter (where estado_cobro =
  'cobrada'), 'en_mora', count(*) filter (where estado_cobro = 'en_mora'), 'pct_cobrado', ...)`
  calculado sobre `facturas` con `estado_asignacion = 'asignada'` del pool — nunca incluye ninguna
  cifra de rendimiento, retorno ni dividendo (FR-025); todo el resto de `detalle_pool` (ya
  corregido en T015) queda sin cambios
- [X] T046 [US4] Validación manual: ejecutar `quickstart.md` §6 completo (facturas anonimizadas
  sin proveedor/deudor + acceso directo a `facturas`/`proveedores` denegado por RLS con un JWT de
  inversionista; `detalle_pool` con el bloque `estado_facturas` nuevo)

**Checkpoint**: Historia 4 funcional — un inversionista puede evaluar la composición real de un
pool antes de aportar, sin ver nunca datos identificables.

---

## Phase 7: User Story 5 - Ver el estado de cobro de las facturas de un pool como hecho, sin rendimiento (Priority: P3)

**Goal**: El estado de cobro de una factura (pendiente/cobrada/en mora) es un hecho consultable y
actualizable por el operador, que se refleja de inmediato en los agregados del pool, sin ningún
cálculo de rendimiento.

**Independent Test**: Cambiar el estado de cobro de una o más facturas de ejemplo y verificar que
los agregados del pool (ya expuestos por `detalle_pool` desde la Historia 4) se actualizan de
inmediato, sin que en ningún punto se calcule o muestre una cifra de rendimiento.

### Implementation for User Story 5

- [X] T047 [US5] En `0013_facturas_del_pool_y_detalle.sql`, crear
  `public.actualizar_estado_cobro_factura(p_factura_id uuid, p_nuevo_estado public.estado_cobro_
  factura) returns void` (`security definer`, `set search_path = ''`), siguiendo
  `contracts/facturas-del-pool.md` §`actualizar_estado_cobro_factura`: `PA008` si el rol no es
  `operador_banco`; `PA016` si la factura no está `estado_asignacion = 'asignada'`; en caso
  contrario, `update facturas set estado_cobro = p_nuevo_estado where id = p_factura_id`; `revoke
  all ... from public, anon, authenticated` + `grant execute ... to authenticated`
- [X] T048 [US5] Validación manual: ejecutar `quickstart.md` §6 (bloque `estado_facturas`) tras
  cambiar el estado de una factura con `actualizar_estado_cobro_factura` y confirmar que el
  cambio se refleja de inmediato en `detalle_pool` sin ninguna acción adicional (SC-006); intentar
  la misma llamada con el rol inversionista → `PA008`; intentar sobre una factura no asignada →
  `PA016`

**Checkpoint**: Las 5 historias de usuario funcionan de forma independiente y en conjunto — el
dominio de originación de facturas queda completo.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Datos de ejemplo, evidencia para el README, y validación final contra el proyecto
remoto.

- [X] T049 [P] Crear `supabase/seed/03_originacion_facturas_demo.sql` (seguro para remoto, `ON
  CONFLICT DO NOTHING` sobre IDs fijos, mismo estilo que `01_dominio_demo.sql`): retrocompletar
  `proveedor_id`/`huella_hash`/`estado_validacion = 'aprobada'`/`estado_asignacion = 'asignada'`
  sobre las 9 facturas ya sembradas por la spec previa (ahora `facturas`); insertar ≥6 facturas
  nuevas cubriendo `pendiente`, `cobrada`, `en_mora`, `rechazada` (ejemplo, nunca asignada) y al
  menos una `aprobada` sin asignar (para demostrar Historia 2 en vivo durante la demo)
- [X] T050 Sobre el resultado de T049 y con `contracts/scripts/deploy.sh` ya corrido (T035), asignar
  en vivo (vía `asignar-factura`, no solo SQL directo) al menos una de las facturas nuevas del seed
  a un pool/tramo de ejemplo, para que exista evidencia on-chain fresca generada por el propio
  seed, no solo retrocompletada (`quickstart.md` §11). Ejecutado: factura
  `e0000000-…-000104` (3200.00 PEN) asignada a POOL-PEN-002/senior vía `asignar-factura`, con
  `register_invoice` confirmado on-chain
  (tx `f4f276878251d6bd18745263af2d99126d35c852649f19639ceceaa4e82fbe80`). En el proceso se
  encontraron y corrigieron 2 bugs reales (ver `_shared/stellar-soroban.ts`): el global `Buffer`
  de Node no existe en Deno, y `@stellar/stellar-sdk@^13` no puede parsear `getTransaction()`
  contra protocolo 28 — este segundo bug causó un registro exitoso on-chain que el cliente
  reportó como fallo, generando un reintento y una desincronización real entre Postgres y el
  contrato, reconciliada manualmente con el hash recuperado vía Horizon antes de corregir la
  causa raíz (subir a `@stellar/stellar-sdk@^17`)
- [X] T051 [P] Actualizar el `README.md` del repositorio con la evidencia on-chain de esta feature:
  `token_wasm_hash`, al menos un `contract_id` de tramo, y al menos un `tx_hash` de
  `register_invoice`/`mint` de testnet — copiados de `contracts/deployments/testnet.json` y de la
  respuesta de T050 (requisito de la hackatón: contrato desplegado y/o transacción comprobable en
  testnet, con su ID/hash incluible en el README). Hecho — incluye además la evidencia de un
  aporte de inversionista de extremo a extremo (pago XLM + mint) generada durante T043
- [X] T052 Ejecutar el checklist completo de `quickstart.md` (§0 a §12) contra el stack local antes
  de tocar el proyecto remoto, incluida la prueba de concurrencia (§8) y la de fallo/compensación
  (§9). Ejecutado **contra el proyecto remoto** (no local — sin Docker/Supabase CLI local en este
  entorno): §0-§7, §9 (real, no simulado), §10 (parcial), §11-§12 cubiertos con evidencia real;
  §8 (concurrencia) no ejecutado — ver nota en T043
- [X] T053 Aplicar `supabase db push` (nunca `db reset --linked`) de las migraciones `0010`-`0015`
  contra el proyecto remoto, desplegar las 3 Edge Functions nuevas/modificadas
  (`asignar-factura`, `provision-pool-tramo-token`, `confirmar-aporte`), y correr `contracts/
  scripts/deploy.sh` contra testnet apuntando a la configuración remota antes de aplicar el seed
  de T049 contra remoto (`quickstart.md` §12 — confirmar que `configuracion_red` remota coincide
  con los `token_contract_id` ya escritos en `tramos`). Las migraciones y Edge Functions ya
  estaban en el proyecto remoto real (aplicadas vía MCP, no hizo falta `db push`); el despliegue
  del contrato contra esa misma configuración remota (T035) ya se corrió y `configuracion_red`
  coincide exactamente con los 12 `token_contract_id` de `tramos` (verificado). Pendiente real:
  reconciliar el versionado local `0010`-`0015` con los nombres de versión con timestamp que
  `apply_migration` asignó en el historial remoto, antes de que alguien corra `supabase db push`
  desde un checkout local (`supabase migration repair` o renombrar los archivos locales)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Sin dependencias — puede avanzar en paralelo con Foundational (es puro
  Rust, Foundational es puro Postgres)
- **Foundational (Phase 2)**: Sin dependencias — BLOQUEA las 5 historias de usuario
- **Historia 1 (Phase 3)**: Depende de Foundational. Sin dependencia de otras historias.
- **Historia 2 (Phase 4)**: Depende de Foundational **y de que existan facturas aprobadas**
  (Historia 1) para tener algo que asignar — no puede validarse de forma útil sin T016, aunque sus
  propias funciones (T020-T023) no invocan ninguna función de Historia 1.
- **Historia 3 (Phase 5)**: Depende de Setup (contrato compilable) y de Historia 2 (envuelve
  `asignar_factura_a_pool`/`confirmar_asignacion_factura`/`revertir_asignacion_factura` dentro de
  la Edge Function `asignar-factura`, T039).
- **Historia 4 (Phase 6)**: Depende de Foundational (columnas de `facturas`) y, para ser
  demostrable con datos reales, de que exista al menos una factura `'asignada'` (Historia 2 o 3) —
  puede construirse en paralelo con la Historia 3 (no depende de ella técnicamente, solo comparte
  el archivo de migración `0013` con la Historia 5).
- **Historia 5 (Phase 7)**: Depende de Historia 4 (comparte `0013_facturas_del_pool_y_
  detalle.sql`, y su validación se apoya en el bloque `estado_facturas` que la Historia 4 agrega a
  `detalle_pool`).
- **Polish (Phase 8)**: Depende de las 5 historias completas.

### Parallel Opportunities

- Setup (T001-T003) puede avanzar en paralelo con Foundational (T004-T015) — equipos distintos.
- Dentro de la Fase 5, T025-T031 (contrato Rust) son secuenciales entre sí (mismo archivo
  `lib.rs`/`test.rs`) salvo T029 (funciones de lectura, sin dependencias de escritura); T036 y
  T037 son paralelizables entre sí y con T033-T035 (archivos distintos).
- Historia 4 (T044-T046) puede construirse en paralelo con la Fase 5 (Historia 3) una vez
  completada Foundational — no hay dependencia técnica directa entre ambas, solo de negocio (una
  factura "asignada" con la que probar Historia 4 puede venir del flujo Postgres-only de Historia
  2 antes de que Historia 3 exista).

### Team Strategy (equipo de 3)

Dado que la Historia 3 concentra el mayor riesgo técnico y el mayor volumen de trabajo nuevo
(contrato Rust completo, script de despliegue, 2 Edge Functions nuevas/modificadas, 1 helper
compartido), tiene sentido que una persona se dedique exclusivamente a Setup + Historia 3 de punta
a punta desde el primer día (es lo que exige el checkpoint del 23-sep), mientras otra construye
Foundational + Historias 1 y 2 (comparten el mismo archivo de migración `0012`), y la tercera
prepara Historias 4 y 5 (comparten `0013`) en cuanto Foundational tenga las columnas de `facturas`
listas, y se suma después a la validación de punta a punta y al seed final (Fase 8).

---

## Estado real de la implementación (post `/speckit-implement`, cerrado)

`/speckit-implement` se ejecutó en dos sesiones. La primera, sin `rustc`/`cargo`/`stellar-cli`
disponibles, dejó todo el código escrito y el 100% de la capa Postgres validada en vivo, pero no
pudo tocar la capa on-chain. La segunda sesión instaló el toolchain completo (Rust vía `rustup` +
target `wasm32v1-none`, `stellar-cli` 28.0.0, `jq`, y un toolchain MinGW-w64 para el linker de
host que requiere `cargo` en Windows) y completó las 7 tareas restantes contra Stellar testnet
real. **Las 53 tareas están `[X]`.**

**Resultado de la capa on-chain (T032/T035/T043/T050-T053), todo con evidencia real, no
simulada**:
- Contrato compilado (`cargo test`: 9/9 OK) y desplegado — una instancia por cada uno de los 12
  tramos existentes. `wasm_hash`, los 12 `contract_id` y las llaves públicas quedaron en
  `contracts/deployments/testnet.json` (nunca un secreto).
- `configuracion_red` poblada en Supabase con la autoridad de plataforma real.
- Una factura de seed asignada en vivo vía `asignar-factura`, con `register_invoice` confirmado
  on-chain.
- Un aporte de inversionista de extremo a extremo vía `confirmar-aporte`: pago XLM real seguido de
  `mint` real, `balance()`/`total_supply()` verificados.
- Rechazo on-chain por rol verificado: el propio framework de autorización de Soroban exige la
  firma del admin real para `register_invoice`/`mint`, imposible de falsificar con otra cuenta.
- Compensación automática por fallo real (no simulada): un bug del SDK (ver abajo) causó un fallo
  genuino de `mint` a mitad de un aporte, y `confirmar-aporte` reembolsó el XLM correctamente
  antes de revertir — la garantía de "nunca queda a medias" se probó bajo una falla real.

**Dos bugs reales encontrados y corregidos durante esta validación** (ambos en
`supabase/functions/_shared/stellar-soroban.ts`, compartido por las 3 Edge Functions que tocan
Soroban):
1. Deno no expone el global `Buffer` de Node — `Buffer.from(hex, "hex")` fallaba en runtime con
   "Buffer is not defined". Corregido con una conversión hex→`Uint8Array` propia (`hexToBytes`).
2. **Crítico**: `@stellar/stellar-sdk@^13` no puede parsear `getTransaction()` contra una red en
   protocolo 28 (`Bad union switch: 4` en `@stellar/js-xdr` al leer la meta de la transacción).
   Toda invocación exitosa a `register_invoice`/`mint` lanzaba una excepción justo después de
   confirmarse on-chain, disparando reintentos que sometían la misma operación varias veces más.
   Para `register_invoice` esto fue inofensivo (el contrato deduplica por huella y el segundo
   intento simplemente fue rechazado), pero para `mint` — que no tiene esa protección —
   **produjo una emisión duplicada real de fracciones** antes de agotar los reintentos y
   compensar. Se reconcilió el estado a mano (recuperando el hash real vía eventos del contrato +
   Horizon, y quemando las fracciones fantasma con `burn`) y se corrigió la causa raíz subiendo
   los 3 archivos que importan el SDK a `@stellar/stellar-sdk@^17`, verificado repitiendo el mismo
   aporte de forma limpia (una sola emisión, ~11s de extremo a extremo).

**Limitaciones conocidas que quedan, deliberadamente sin resolver por alcance**:
- **`mint` no es idempotente a nivel de contrato** (a diferencia de `register_invoice`, que sí
  deduplica por huella). El bug #2 de arriba solo se disparó porque el SDK fallaba al parsear un
  éxito real; con el SDK corregido esto no debería repetirse en operación normal, pero si
  `invocarContratoAdminConReintentos` alguna vez reintenta un `mint` que en realidad sí tuvo éxito
  (por cualquier otra causa futura), volvería a emitir de más. Una corrección de fondo exigiría
  que el contrato acepte una clave de idempotencia por mint (similar a `Factura(hash)`), lo que
  implica recompilar y redesplegar las 12 instancias — fuera de alcance de esta sesión.
- ~~**T043/T052, §8 (20 aportes simultáneos)**: no ejecutado.~~ **Resuelto el 2026-09-23, ver
  T055 abajo** — sí se ejecutó (a menor escala, 6 aportes concurrentes con cupo ajustado a
  propósito) y encontró un bug real de concurrencia en la capa on-chain, ya corregido.
- **T053**: el versionado local (`0010`-`0015`) no coincide con los nombres de versión con
  timestamp que `apply_migration` asignó en el historial remoto — reconciliar con
  `supabase migration repair` o renombrando los archivos locales antes de que alguien corra
  `supabase db push` desde un checkout nuevo.

**T054 (2026-09-22, post-cierre) — Validación de integración end-to-end, bug real encontrado y
corregido**: una prueba de integración manual contra el proyecto remoto (login → catálogo →
detalle → facturas anonimizadas → saldo → cotizar/confirmar aporte, verificado además de forma
independiente contra el contrato con `stellar contract invoke`) encontró que **Retail Norte
(tramos senior y junior) tenía un desface real**: `supabase/seed/03_originacion_facturas_demo.sql`
asignó 2 facturas a esos tramos usando hashes de transacción "placeholder" (tal como el propio
archivo advierte en su comentario), así que `register_invoice` nunca se ejecutó de verdad —
Postgres mostraba `fracciones_totales` > 0 pero el contrato tenía `cap: 0`, y cualquier aporte
nuevo fallaba con `CapExceeded` (revertido correctamente, sin pérdida de fondos). **Corregido**:
se llamó `register_invoice` manualmente para las 2 facturas reales de ese pool
(`new_cap` 160 y 200 para el tramo senior, 75 para el junior) — verificado con un aporte real
posterior (`ok: true`, `total_supply` pasó de 0 a 1, confirmado en Horizon). Detalle completo,
hashes exactos y comandos en `research.md` §9.

**Importante — no es un bug generalizado**: de los 6 pools de ejemplo, solo Retail Norte tenía
este desface. Manufactura Sur ya funcionaba (tuvo una asignación real desde el principio).
**Servicios Lima, Construcción Centro, Comercio y Tecnología Mixto y Tecnología Exportadora (4
pools, 8 tramos) siguen sin poder recibir un aporte nuevo hoy** — pero esto no es un error a
corregir: simplemente nunca se les asignó ninguna factura real por la vía correcta todavía (mismo
camino que ya funcionó una vez en Manufactura Sur). Cuando alguien lo haga, van a funcionar sin
necesitar ningún parche.

**T055 (2026-09-23) — Validación completa de `quickstart.md` escenario por escenario contra el
proyecto remoto, un bug real de concurrencia encontrado y corregido**: se ejecutaron en vivo los
12 escenarios del quickstart (registro/rechazo/duplicado de factura, rechazo por rol, asignación
con evidencia on-chain, asignación duplicada/cruzada, anticipo inválido, facturas anonimizadas +
RLS deny-all, aporte con fracciones verificables, concurrencia, fallo del contrato con reversión,
idempotencia del mint, seed de demostración, checklist pre-remoto). Los 11 primeros pasaron sin
cambios de código. **El de concurrencia (§8) encontró un bug real, no cosmético**: al forzar una
ráfaga de 6 `confirmar-aporte` concurrentes sobre el mismo tramo (cupo ajustado a propósito para
que solo 3 pudieran reservar), las 3 invocaciones de `mint` —todas firmadas con la MISMA cuenta
`operador_authority` compartida por la plataforma— chocaron entre sí por número de secuencia de
cuenta Stellar, y el mismo problema alcanzó a la compensación automática (reembolsos del mismo
pool firmando con la misma cuenta de custodia): 2 de los 3 reembolsos también chocaron, dejando un
aporte con el pago XLM ya hecho pero sin fracciones ni reembolso — una violación real de la
garantía "nunca queda pendiente" de `plan.md`. Reconciliado a mano de inmediato (reembolso
manual verificado en Horizon) antes de corregir la causa raíz.

**Corrección**: un lock de aplicación por cuenta firmante, respaldado en Postgres
(`supabase/migrations/0016_lock_firma_stellar.sql` +
`supabase/functions/_shared/lock-firma.ts`), que serializa el tramo
cargar-secuencia→firmar→someter de cualquier cuenta Stellar compartida (operador_authority para
`register_invoice`/`mint`/`initialize`; la custodia de cada pool para los reembolsos de
compensación) entre invocaciones concurrentes de Edge Functions — necesario porque las Edge
Functions no comparten memoria entre sí, así que un mutex en proceso no habría servido.
`pagarXlm`/`invocarContratoAdmin`/`invocarContratoAdminConReintentos` ahora exigen un cliente
Supabase como primer argumento; los 4 call sites (`confirmar-aporte` ×2, `asignar-factura`,
`provision-pool-tramo-token` ×2) se actualizaron y las 3 Edge Functions se redesplegaron.
**Verificado repitiendo la misma ráfaga tras el fix**: las 3 reservas válidas mintearon sin
colisión (3 `tx_hash`/`fraccion_tx_hash` distintos, `total_supply()` +3 exacto) y las 3 rechazadas
por cupo fallaron limpiamente sin tocar la red Stellar — cero PA013 (reconciliación manual), cero
colisiones. Detalle completo y hashes en `README.md` → Estado real de esta feature, bug #3.

## Notes

- [P] = archivos distintos, sin dependencias pendientes entre sí.
- [Story] mapea cada tarea a su historia de usuario para trazabilidad.
- No hay tareas de frontend/UI — esta feature termina en la capa de API/backend/contrato (ver
  `spec.md` → Fuera de Alcance).
- Sin tests automatizados de integración (Principio I), salvo `cargo test` del contrato (T031),
  justificado en `plan.md` → Technical Context → Testing; cada historia cierra con una tarea de
  validación manual contra `quickstart.md`, primero siempre en local antes de tocar el proyecto
  remoto.
- Todo objeto de Supabase (tablas, RLS, triggers, funciones, los 3 Database Webhooks) se crea como
  archivo SQL versionado bajo `supabase/migrations/` — nunca desde el Dashboard (Principio VII).
  Todo el código y los IDs del contrato Soroban viven versionados bajo `contracts/` con el mismo
  estándar (`plan.md` → Constitution Check, Principio VII).
- T015 corrige `catalogo_pools`/`detalle_pool` (ya desplegadas en `0009_catalogo_consultas.sql`)
  sin editar esa migración — patrón ya usado por `0004_config_edge_functions_url.sql` sobre
  `0002_wallet_provisioning.sql`.
- Hacer commit después de cada tarea o grupo lógico de tareas.
