# Tasks: Cobro de Facturas, Reparto de Retornos y Reloj de Demo

**Input**: Design documents from `specs/20260923-210731-cobro-reparto-retornos/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — todos generados.

**Tests**: sin tests automatizados (Principio I; no hay contrato nuevo, así que tampoco aplica `cargo test`). Validación manual con `quickstart.md`.

**Organización**: por historia de usuario. **La presentación es el 2026-09-26**: el camino mínimo demostrable es **US1 + US2** (cobro real → mora/cascada → reparto real con pagos individuales). US3 completa la demo si hay tiempo; **US4 (reloj por pool) y el pulido son opcionales**.

## Reglas transversales (aplican a TODAS las tareas)

- **Versionado (Principio VII)**: todo artefacto vive en git antes o al mismo tiempo que se despliega. Migraciones en `supabase/migrations/`, funciones en `supabase/functions/`, `supabase/config.toml`. Aplicar migraciones con `supabase db push` o MCP `apply_migration` **leyendo el `.sql` del repo**; desplegar funciones con `supabase functions deploy <nombre>`. Cada tarea de despliegue termina con `git status` sin cambios de `supabase/` fuera de git.
- **Nunca editar migraciones ya aplicadas** (`0001`–`0019`). Las de esta feature son `0020`–`0026`; si una migración ya se aplicó, un cambio va en una migración nueva.
- **Códigos de error propios: `PA030`–`PA039`** (`PA021`–`PA023` los usa la spec `liquidacion-tramo`). Tabla en `data-model.md` (se usan `PA030`–`PA038`; `PA039` queda libre).
- **NO revocar `actualizar_estado_cobro_factura`** (0013): la usa la spec `liquidacion-tramo`.
- **`[COORD]`**: requiere avisar y acordar con la autora de `specs/20260925-002004-liquidacion-tramo` antes de aplicar.
- Estilo de las migraciones: `security definer`, `set search_path = ''`, `revoke all … from public, anon, authenticated` + `grant execute … to service_role` (funciones internas), tablas con RLS habilitada y `revoke all` a `anon`/`authenticated` (patrón de 0003/0011/0017).
- Estilo de las Edge Functions: como `supabase/functions/asignar-factura/index.ts` (JWT → rol `operador_banco` por `perfiles` → RPC con `service_role`), `Deno.serve`, respuestas `{ ok, … }` / `{ ok:false, error:{code,message} }`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizable (archivos distintos, sin dependencia de una tarea sin terminar)
- **[Story]**: US1 cobro · US2 reparto automático · US3 reparto forzado · US4 reloj por pool

---

## Phase 1: Setup — estado real y coordinación

- [ ] T001 [COORD] Verificar el estado real antes de escribir nada: `git pull` (debe incluir `b59856a`/`5768e37`), `list_migrations` del proyecto `qqpozotcrxfukkwcoget` debe terminar en `0019_liquidacion_tramo_tipo_cambio`, y `list_edge_functions` debe incluir `liquidar-tramo`. Avisar a la autora de `liquidacion-tramo` (mensaje con: migraciones `0020`+, códigos `PA030`+, que se conserva `actualizar_estado_cobro_factura`, y que la migración `0022` redefinirá `iniciar_liquidacion_tramo` para la exclusión mutua — ver T021). Anotar su respuesta en `research.md` §11.
- [ ] T002 Elegir y anotar en `quickstart.md` §0 los pool/tramos de demo: uno con aportes confirmados **on-chain reales** de ≥ 2 inversionistas en el junior y ≥ 1 en el senior, con facturas asignadas, y que **no** hayan sido liquidados por `liquidar-tramo` (`tramos.estado_liquidacion = 'activo'`) ni tengan `tramos.reparto_estado` distinto de `sin_reparto`. Los datos se crean con las funciones reales (no seed SQL): `registrar_factura` → `asignar-factura` → `recargar-wallet` → `cotizar_aporte` → `confirmar-aporte`.

---

## Phase 2: Foundational (bloquea todas las historias)

**⚠️ CRÍTICO**: ninguna historia puede empezar hasta terminar esta fase.

- [ ] T003 [P] Crear `supabase/migrations/0020_reloj_pool.sql` (solo la **base** del reloj, sin cambiar ninguna regla existente): tabla `reloj_pool` (`pool_id uuid primary key references public.pools(id)`, `desplazamiento interval not null default '0' check (desplazamiento >= interval '0')`, `updated_at timestamptz not null default now()`, `actualizado_por uuid null references auth.users(id)`), tabla `reloj_pool_avances` (`id uuid primary key default gen_random_uuid()`, `pool_id uuid not null references public.pools(id)`, `avance interval not null check (avance > interval '0')`, `desplazamiento_antes interval not null`, `desplazamiento_despues interval not null`, `fecha_efectiva_despues timestamptz not null`, `operador_id uuid not null references auth.users(id)`, `fecha_real_at timestamptz not null default now()`), ambas con RLS habilitada y `revoke all` a `anon`/`authenticated`; funciones `ahora_pool(p_pool_id uuid) returns timestamptz` = `now() + coalesce((select desplazamiento from public.reloj_pool where pool_id = p_pool_id), interval '0')` (`stable`, sin fila = reloj real) y `hoy_pool(p_pool_id uuid) returns date` = fecha de `ahora_pool` en `America/Lima`; ambas `security definer`, `set search_path = ''`, `grant execute` a `authenticated` y `service_role`. Cabecera con referencia a la spec. Contrato: `contracts/reloj-pool.md`.
- [ ] T004 [P] Extender `supabase/functions/_shared/stellar-payment.ts` **sin romper las firmas actuales**: (a) `prepararPagoXlm(secretOrigen, destinoPublicKey, montoXlm, memo?: string)` añade `.addMemo(Memo.text(memo))` solo si se pasa (memo ≤ 28 bytes); (b) `fondearConFriendbot(publicKey: string): Promise<void>` que llama `https://friendbot.stellar.org/?addr=<publicKey>` con timeout y lanza si falla; (c) `fusionarCuentaEn(secretOrigen: string, destinoPublicKey: string): Promise<{ hash: string }>` con `Operation.accountMerge({ destination })` firmando con `secretOrigen` y enviando con `enviarTransaccionXdr`. Importar `Memo` de `npm:@stellar/stellar-sdk@^17`.
- [ ] T005 [P] Registrar en `supabase/config.toml` (junto a `[functions.asignar-factura]`) `[functions.cobrar-factura]`, `[functions.marcar-factura-mora]` y `[functions.repartir-tramo]`, las tres con `verify_jwt = true` y un comentario de una línea que apunte a esta spec.
- [ ] T006 Aplicar `0020_reloj_pool.sql` (CLI o MCP leyendo el archivo), confirmar con `list_migrations` que aparece `0020`, y comprobar en SQL que `select public.ahora_pool(id) from public.pools limit 1` ≈ `now()`. Verificar `git status` (los archivos de T003–T005 deben estar en git o listos para commit; ninguno solo en el remoto). (depende de T003)

**Checkpoint**: base del reloj aplicada, helpers de Stellar y `config.toml` listos.

---

## Phase 3: User Story 1 — Simular el cobro de una factura (Priority: P1) 🎯 MVP

**Goal**: el operador cobra una factura asignada con una transferencia real deudor → custodia (o la marca en mora) y la factura queda en estado final.

**Independent Test**: `quickstart.md` §3 — cobrar F1, ver el pago en Horizon (memo `cobro:…`), repetir sin segundo pago, probar rol incorrecto, factura no asignada, fondos insuficientes del deudor (reposición) y fallo con reintento; marcar otra factura en mora sin movimiento de dinero.

### Base de datos (`supabase/migrations/0021_cobro_facturas.sql`, un solo archivo → tareas secuenciales)

- [ ] T007 [US1] Crear `0021_cobro_facturas.sql` con cabecera estándar y, en él: `create type public.estado_cobro_stellar as enum ('reservado', 'confirmado', 'fallido')`; `create type public.estado_reparto_tramo as enum ('sin_reparto', 'en_curso', 'cerrado')`; `alter table public.tramos add column reparto_estado public.estado_reparto_tramo not null default 'sin_reparto'` (copia denormalizada, fuente de verdad `repartos_tramo`; solo la modifican las funciones de reparto).
- [ ] T008 [US1] En `0021`: tabla `public.cuenta_deudor_demo` (`singleton boolean primary key default true check (singleton)`, `public_key text not null unique`, `secret_id uuid not null unique`, `fondeada_at timestamptz`, `created_at timestamptz not null default now()`) con RLS habilitada + `revoke all` a `public, anon, authenticated`; funciones `aprovisionar_cuenta_deudor(p_public_key text, p_secret_key text) returns jsonb` (idempotente con `pg_advisory_xact_lock(hashtextextended('paul:stellar-demo-debtor', 0))`, guarda el secreto con `vault.create_secret(p_secret_key, 'stellar_demo_debtor')`, devuelve `{public_key, secret_key}`) y `obtener_cuenta_deudor() returns jsonb` (`stable`), copiando el patrón exacto de `aprovisionar_tesoreria_demo`/`obtener_tesoreria_demo` de `0017_recargas_stellar.sql`; ambas solo `service_role`. (depende de T007)
- [ ] T009 [US1] En `0021`: `alter table public.facturas add column cierre_forzado boolean not null default false, add column estado_final_at timestamptz null, add column estado_final_efectivo_at timestamptz null, add column estado_final_por uuid null references auth.users(id)`; y el trigger `facturas_guardia_estado_cobro` (`before update of estado_cobro on public.facturas`) con función `set search_path = ''`: si `new.estado_cobro = old.estado_cobro` → permitir (no-op); si `old.estado_cobro <> 'pendiente'` → `raise exception '…' using errcode = 'PA030'` (solo se admite `pendiente → cobrada | en_mora`); si el tramo de la factura (`facturas.tramo_id`) tiene `reparto_estado = 'cerrado'` → `PA032`. **No revocar ni modificar `actualizar_estado_cobro_factura`**: el trigger no debe romper su flujo `pendiente → cobrada`. (depende de T007)
- [ ] T010 [US1] En `0021`: tabla `public.cobros_factura` con las columnas exactas de `data-model.md`: `id uuid primary key default gen_random_uuid()`, `factura_id uuid not null references public.facturas(id)`, `pool_id uuid not null references public.pools(id)`, `tramo_id uuid not null references public.tramos(id)`, `monto_nominal numeric not null`, `moneda public.moneda_soportada not null`, `tipo_cambio_aplicado numeric not null`, `monto_xlm numeric(20,7) not null check (monto_xlm > 0)`, `cuenta_origen text not null`, `cuenta_destino text not null`, `estado public.estado_cobro_stellar not null default 'reservado'`, `tx_hash text null`, `tx_xdr text null`, `motivo_fallo text null`, `operador_id uuid not null references auth.users(id)`, `created_at timestamptz not null default now()`, `confirmado_at timestamptz null`, `confirmado_efectivo_at timestamptz null`; **índice único parcial** `(factura_id) where estado in ('reservado','confirmado')` y `(tx_hash) where tx_hash is not null`; RLS + `revoke all` a `anon`/`authenticated`. (depende de T007)
- [ ] T011 [US1] En `0021`, funciones `service_role` (todas toman `select … for update` sobre la factura): `iniciar_cobro_factura(p_factura_id uuid, p_operador_id uuid) returns jsonb` — `PA016` si no existe; `PA031` si `estado_asignacion <> 'asignada'` o `estado_validacion = 'rechazada'` o `estado_cobro <> 'pendiente'`; `PA032` si el tramo tiene `reparto_estado = 'cerrado'` o `estado_liquidacion <> 'activo'`; si ya hay cobro `confirmado` devuelve ese cobro con `ya_existia: true`; si hay uno `reservado` lo devuelve para reanudar; si no, calcula `monto_xlm = round(monto_nominal / tasa_moneda_por_xlm, 7)` con `public.tipo_cambio_vigente(moneda)` (la misma convención de `0006`), toma `pools.custody_public_key` como `cuenta_destino` y `cuenta_origen` de `cuenta_deudor_demo`, inserta `cobros_factura` en `reservado` y devuelve `{cobro_id, monto_xlm, tipo_cambio_aplicado, cuenta_origen, cuenta_destino, pool_id, tramo_id, tx_xdr, tx_hash}`. Además `registrar_tx_cobro(p_cobro_id uuid, p_tx_hash text, p_tx_xdr text)`, `confirmar_cobro_factura(p_cobro_id uuid)` (cobro → `confirmado` con `confirmado_at = now()` y `confirmado_efectivo_at = public.ahora_pool(pool_id)`; factura → `cobrada` con `estado_final_at = now()`, `estado_final_efectivo_at = public.ahora_pool(pool_id)`, `estado_final_por = operador_id`; idempotente) y `fallar_cobro_factura(p_cobro_id uuid, p_motivo text)` (cobro → `fallido` con `motivo_fallo`, libera el índice único; la factura sigue `pendiente`). (depende de T009, T010)
- [ ] T012 [US1] En `0021`: `marcar_factura_en_mora(p_factura_id uuid, p_operador_id uuid, p_cierre_forzado boolean default false) returns jsonb` (`service_role`, `for update`): mismas validaciones `PA016`/`PA031`/`PA032`; `estado_cobro = 'en_mora'`, `cierre_forzado = p_cierre_forzado`, `estado_final_at = now()`, `estado_final_efectivo_at = public.ahora_pool(pool_id)`, `estado_final_por = p_operador_id`; si ya estaba `en_mora` con el mismo operador devuelve `ya_existia: true`; devuelve `{factura_id, estado_cobro, cierre_forzado, pool_id, tramo_id}`. (depende de T009)
- [ ] T013 [US1] En `0021`: cerrar el hallazgo del asesor de Supabase sobre `public.lock_firma_stellar` (`alter table … enable row level security` + `revoke all on public.lock_firma_stellar from public, anon, authenticated`; verificar antes que `adquirir_lock_firma`/`liberar_lock_firma` (0016) son `security definer` para no romper el lock). (depende de T007)

### Edge Functions

- [ ] T014 [P] [US1] Crear `supabase/functions/_shared/cuenta-deudor.ts`: `obtenerCuentaDeudor(supabase)` (RPC `obtener_cuenta_deudor`; si es `null`: `Keypair.random()`, `aprovisionar_cuenta_deudor(public, secret)`, `fondearConFriendbot` **una sola vez** y lo que devuelva la RPC manda ante carreras) y `asegurarFondos(supabase, cuenta, montoXlm)`: exige `obtenerBalanceXlm(cuenta.public_key) − 1.5 ≥ montoXlm`; si no, repone hasta 3 veces con una cuenta efímera (`Keypair.random()` → `fondearConFriendbot` → `fusionarCuentaEn(secretEfimera, cuenta.public_key)`), y si aún no alcanza devuelve `{ok:false, requerido_xlm, disponible_xlm}`. Comentario de cabecera con el hallazgo del límite de ~10 000 XLM por Friendbot (`research.md` §4). (depende de T004, T008)
- [ ] T015 [US1] Crear `supabase/functions/cobrar-factura/index.ts` siguiendo `contracts/cobrar-factura-function.md`: JWT + rol `operador_banco` (`403 PA008`); cuerpo `{ factura_id }` (`400 PA012`); `iniciar_cobro_factura`; si `ya_existia` y `confirmado` → responder ese cobro; `asegurarFondos` (si falta → `fallar_cobro_factura` y `402 PA033`); dentro de `conLockFirma(cuentaDeudor)`: reutilizar `tx_xdr` guardado si ya existe o `prepararPagoXlm(secretoDeudor, cuenta_destino, monto_xlm, "cobro:" + primeros 8 de cobro_id)` → `registrar_tx_cobro` **antes** de `enviarTransaccionXdr`; éxito → `confirmar_cobro_factura`; error → `existeTransaccion(hash)`: si existe confirma, si no `fallar_cobro_factura` y `502 PA034`. Mapear errores de Postgres a `{code,message}` como `asignar-factura`. Respuesta según el contrato (campo `reparto: null` por ahora; se integra en T030). (depende de T011, T014)
- [ ] T016 [P] [US1] Crear `supabase/functions/marcar-factura-mora/index.ts` según `contracts/marcar-factura-mora-function.md`: JWT + rol; cuerpo `{ factura_id }`; `marcar_factura_en_mora(factura_id, operador_id, false)`; respuesta con `reparto: null` por ahora (se integra en T030). (depende de T012)

### Despliegue y validación

- [ ] T017 [US1] Aplicar `0021_cobro_facturas.sql` (leyendo el archivo del repo), desplegar `supabase functions deploy cobrar-factura marcar-factura-mora`, verificar `list_migrations` (`0021`) y `list_edge_functions`, y `git status` sin artefactos fuera de git. (depende de T013, T015, T016)
- [ ] T018 [US1] Validar `quickstart.md` §3 completo (pago visible en Horizon con memo `cobro:…`, doble llamada sin segundo pago, `403 PA008` con inversionista, `PA031` sin asignar, reposición del deudor por Friendbot+merge, fallo → `PA034` → reintento con un solo pago) y §4 pasos 2 (mora sin movimiento de dinero). Además comprobar que `actualizar_estado_cobro_factura` sigue funcionando sobre una factura de otro tramo de prueba (flujo de `liquidacion-tramo`). (depende de T017)

**Checkpoint**: US1 funcional — cobro real y mora, sin reparto todavía.

---

## Phase 4: User Story 2 — Repartir el pool a los inversionistas (Priority: P1) 🎯 MVP

**Goal**: cuando todas las facturas del pool están en estado final, se calcula la cascada senior/junior y cada inversionista recibe su pago real en una transacción propia; el tramo queda cerrado, irreversible.

**Independent Test**: `quickstart.md` §1 (exclusión mutua), §4 (cascada con el ejemplo numérico), §6 (fallo parcial y reintento) y §7 (irreversibilidad).

### Base de datos (`0022_reparto_tramos.sql`, `0023_consultas_reparto.sql`)

- [ ] T019 [US2] Crear `supabase/migrations/0022_reparto_tramos.sql` con cabecera estándar y tipos/tablas de `data-model.md` (RLS + `revoke all` a `anon`/`authenticated` en todas): `create type public.origen_reparto as enum ('automatico','forzado')`, `public.estado_reparto as enum ('en_curso','cerrado')`, `public.estado_pago_reparto as enum ('pendiente','pagado','fallido')`; `liquidaciones_pool` (`pool_id uuid primary key references public.pools(id)`, `tipo_cambio_aplicado numeric not null`, `forzada boolean not null default false`, `capital_junior_xlm`, `capital_senior_xlm`, `rendimiento_junior_xlm`, `rendimiento_senior_xlm`, `perdida_xlm`, `perdida_junior_xlm`, `perdida_senior_xlm` todos `numeric(20,7) not null`, `perdida_moneda numeric not null`, `created_at timestamptz not null default now()`, `fecha_efectiva_at timestamptz not null`); `repartos_tramo` (`id uuid primary key default gen_random_uuid()`, `tramo_id uuid not null unique references public.tramos(id)`, `pool_id uuid not null references public.pools(id)`, `origen public.origen_reparto not null`, `forzado_por uuid null references auth.users(id)`, `estado public.estado_reparto not null default 'en_curso'`, `total_a_pagar_xlm numeric(20,7) not null`, `total_pagado_xlm numeric(20,7) not null default 0`, `n_pagos int not null`, `n_pagados int not null default 0`, `created_at timestamptz not null default now()`, `cerrado_at timestamptz null`, `cerrado_efectivo_at timestamptz null`); `pagos_reparto` (`id uuid primary key default gen_random_uuid()`, `reparto_id uuid not null references public.repartos_tramo(id)`, `tramo_id uuid not null references public.tramos(id)`, `investor_id uuid not null references auth.users(id)`, `wallet_destino text not null`, `fracciones int not null`, `capital_xlm numeric(20,7) not null`, `ajuste_xlm numeric(20,7) not null`, `monto_xlm numeric(20,7) not null check (monto_xlm >= 0)`, `tipo_cambio_aplicado numeric not null`, `estado public.estado_pago_reparto not null default 'pendiente'`, `intentos int not null default 0`, `tx_hash text null`, `tx_xdr text null`, `motivo_fallo text null`, `pagado_at timestamptz null`, **`unique (reparto_id, investor_id)`**). (depende de T017, porque `0021` crea `tramos.reparto_estado`)
- [ ] T020 [US2] En `0022`: `evaluar_reparto_pool(p_pool_id uuid) returns jsonb` (`service_role`, `stable`) → `{elegible, motivo, tramos:[{tramo_id, tipo, tiene_inversionistas, reparto_estado}]}`; elegible ⇔ el pool tiene ≥ 1 factura con `estado_asignacion = 'asignada'` y **ninguna** con `estado_cobro = 'pendiente'`; tramos con `reparto_estado = 'cerrado'` o `estado_liquidacion <> 'activo'` no son candidatos. Y `preparar_liquidacion_pool(p_pool_id uuid, p_forzada boolean default false) returns jsonb` (`service_role`, idempotente: si ya hay fila en `liquidaciones_pool` la devuelve sin recalcular): fija `tipo_cambio_aplicado = tipo_cambio_vigente(moneda)`; por tramo `capital_xlm = Σ aportes.xlm_pagados` con `estado = 'confirmado'`; `rendimiento_xlm = Σ (monto_nominal − anticipo) de facturas cobradas del tramo / tasa`; `perdida_moneda = Σ anticipo de facturas en_mora de todo el pool`, `perdida_xlm = perdida_moneda / tasa`; **cascada**: `perdida_junior_xlm = least(perdida_xlm, capital_junior_xlm)`, `perdida_senior_xlm = least(perdida_xlm − perdida_junior_xlm, capital_senior_xlm)`; todo redondeado a 7 decimales; `fecha_efectiva_at = public.ahora_pool(p_pool_id)`. (depende de T019)
- [ ] T021 [COORD] [US2] En `0022`: (a) `iniciar_reparto_tramo(p_tramo_id uuid, p_origen public.origen_reparto, p_forzado_por uuid default null) returns jsonb` (`service_role`): `select … from public.tramos where id = p_tramo_id for update`; `PA032` si `reparto_estado = 'cerrado'` **o `estado_liquidacion <> 'activo'`** (exclusión mutua); `PA036` si el tramo no tiene aportes confirmados o el pool no es elegible y no es forzado; `insert into public.repartos_tramo … on conflict (tramo_id) do nothing`; `tramos.reparto_estado = 'en_curso'`. (b) **Redefinir** `public.iniciar_liquidacion_tramo(uuid)` con `create or replace`, copiando **literalmente** el cuerpo de `supabase/migrations/0018_liquidacion_tramo.sql` y añadiendo, justo después del rechazo por `estado_liquidacion <> 'activo'`, `if v_tramo.reparto_estado <> 'sin_reparto' then raise exception 'El tramo ya fue repartido por el reparto de retornos.' using errcode = 'PA032'; end if;` — mantener sus `revoke`/`grant`. **No aplicar sin el visto bueno de la autora (T001).** (depende de T019)
- [ ] T022 [US2] En `0022`: `crear_pagos_reparto(p_reparto_id uuid) returns int` (`service_role`, idempotente con `on conflict (reparto_id, investor_id) do nothing`): por inversionista con aportes confirmados en el tramo, `fracciones = Σ monto_nominal / pools.unidad_minima_aporte`, `capital_xlm = Σ xlm_pagados`, `wallet_destino = perfiles.wallet_public_key`; `neto_t = rendimiento_t_xlm − perdida_absorbida_t_xlm` (senior → `perdida_senior_xlm`, junior → `perdida_junior_xlm`); `monto_xlm = greatest(0, floor7(capital_xlm + neto_t * fracciones / Σ fracciones_t))` con `floor7(x) = floor(x * 10^7) / 10^7`; `ajuste_xlm = monto_xlm − capital_xlm`; si `Σ monto_xlm` del tramo excede `capital_t + rendimiento_t − perdida_absorbida_t`, aplicar un factor de escala uniforme antes de insertar; guarda `tipo_cambio_aplicado` de la liquidación y fija `repartos_tramo.total_a_pagar_xlm`/`n_pagos`. Un tramo sin inversionistas → 0 pagos (el llamador lo cierra sin transacciones). (depende de T020, T021)
- [ ] T023 [US2] En `0022`, funciones `service_role` de ejecución: `tomar_pagos_pendientes(p_reparto_id uuid, p_limite int) returns table(...)` (pagos `pendiente`/`fallido` en orden estable por `investor_id`, con `wallet_destino`, `monto_xlm`, `tx_hash`, `tx_xdr`); `registrar_tx_pago_reparto(p_pago_id uuid, p_tx_hash text, p_tx_xdr text)` (`intentos = intentos + 1`, estado sigue `pendiente`); `confirmar_pago_reparto(p_pago_id uuid)` (→ `pagado`, `pagado_at = now()`, actualiza `n_pagados` y `total_pagado_xlm` del reparto; idempotente); `fallar_pago_reparto(p_pago_id uuid, p_motivo text)` (→ `fallido`); `cerrar_reparto_tramo(p_reparto_id uuid) returns jsonb` (**solo si `n_pagados = n_pagos`**, si no `PA034`; → `estado = 'cerrado'`, `cerrado_at = now()`, `cerrado_efectivo_at = public.ahora_pool(pool_id)`, `tramos.reparto_estado = 'cerrado'`). (depende de T019)
- [ ] T024 [US2] Crear `supabase/migrations/0023_consultas_reparto.sql` (`security definer`, `stable`, `search_path = ''`, `grant execute` a `authenticated`, verificando rol dentro): `mis_repartos()` (inversionista, solo `auth.uid()`: pool, tramo, `capital_xlm`, `ajuste_xlm`, `monto_xlm`, `estado_pago`, `tx_hash`, `tipo_cambio_aplicado`, `moneda`, `pagado_at`, `reparto_estado`), `estado_reparto_pool(p_pool_id uuid)` (operador → `PA008` si no; jsonb con la liquidación, por tramo estado/`origen`/contadores/`total_pagado_xlm` y facturas con `cierre_forzado`) y `listar_pagos_reparto(p_tramo_id uuid)` (operador; pagos con estado, `intentos`, `tx_hash`, `motivo_fallo`). Contrato: `contracts/consultas-reparto.md`. (depende de T019)

### Edge Functions

- [ ] T025 [US2] Crear `supabase/functions/_shared/reparto-pagos.ts` con `ejecutarRepartoPool(supabase, poolId, tramoId?, { origen, operadorId, presupuestoMs = 100_000 })` según `contracts/repartir-tramo-function.md`: `evaluar_reparto_pool`; coherencia `Σ fracciones` de aportes confirmados = `consultarSoloLectura(token_contract_id, "total_supply")` (`PA038` si no); `preparar_liquidacion_pool`; por cada tramo candidato con inversionistas: `iniciar_reparto_tramo` → `crear_pagos_reparto`; verificar custodia (`obtenerBalanceXlm(custody) − 1.5 ≥ pagos pendientes de este tramo + comprometidos del otro`, si no `PA035`); secreto con RPC `obtener_secreto_custodia_pool`; bucle de pagos bajo `conLockFirma(custodia)`: reutilizar `tx_xdr`/`tx_hash` guardados (`existeTransaccion` → `confirmar_pago_reparto` sin repagar), o `prepararPagoXlm(secretoCustodia, wallet_destino, monto_xlm, "rep:" + primeros 8 de pago_id)` → `registrar_tx_pago_reparto` **antes** de `enviarTransaccionXdr` → `confirmar_pago_reparto`; ante error, `existeTransaccion` para desambiguar y si no existe `fallar_pago_reparto` y **continuar con el siguiente**; parar al agotar `presupuestoMs`; al terminar, `cerrar_reparto_tramo` si el 100 % está pagado (tramo sin inversionistas → cerrarlo sin transacciones). Devuelve el resumen del contrato (`estado`, `pagos_restantes`, `pagos[]`). (depende de T022, T023, T004)
- [ ] T026 [P] [US2] Crear `supabase/functions/repartir-tramo/index.ts`: JWT + rol operador; cuerpo `{ tramo_id, forzar?: boolean }`; en esta historia solo `forzar: false` (continuar/reintentar un reparto `en_curso` o disparar uno elegible; con facturas pendientes y sin forzar → `409 PA036`; tramo `cerrado` → `409 PA032`); llama a `ejecutarRepartoPool` y devuelve el resumen; `forzar: true` responde `400 PA012` "no disponible" hasta T034. (depende de T025)
- [ ] T027 [US2] Integrar el reparto automático en `supabase/functions/cobrar-factura/index.ts` y `supabase/functions/marcar-factura-mora/index.ts`: tras marcar el estado final llamar a `evaluar_reparto_pool`; si es elegible ejecutar `ejecutarRepartoPool` y devolver el resumen en `reparto`; un fallo del reparto **no** revierte el cobro (`reparto.error`). (depende de T025, T015, T016)

### Despliegue y validación

- [ ] T028 [US2] [COORD] Aplicar `0022` y `0023` **solo tras confirmar T021 con la autora**; desplegar `cobrar-factura`, `marcar-factura-mora` y `repartir-tramo`; verificar `list_migrations` (`0022`, `0023`), `list_edge_functions`, y `git status` limpio en `supabase/`. (depende de T024, T026, T027)
- [ ] T029 [US2] Validar `quickstart.md` §1 (exclusión mutua en ambos sentidos y que `liquidar-tramo` sigue funcionando en un tramo virgen), §4 completo (ejemplo numérico: A = 1 500, B = 1 000, C ≈ 15 555.5555555 XLM; variante con pérdida > capital junior), §6 (fallo parcial de un pago y reintento sin repagar) y §7 puntos 1–2 (tramo cerrado rechaza todo; ráfaga de 20 llamadas → un solo reparto, un pago por inversionista). Cada pago debe verificarse en Horizon. (depende de T028)

**Checkpoint**: US1 + US2 = **MVP de la demo**: aporte → cobro → cascada → pagos reales a los inversionistas.

---

## Phase 5: User Story 3 — Forzar el reparto de un tramo (Priority: P2)

**Goal**: el operador reparte aunque queden facturas pendientes; estas pasan a mora por cierre forzado.

**Independent Test**: `quickstart.md` §5.

- [ ] T030 [US3] Crear `supabase/migrations/0024_forzar_reparto.sql`: `forzar_reparto_pool(p_pool_id uuid, p_operador_id uuid) returns jsonb` (`service_role`, una transacción con `for update` sobre las facturas): valida que el tramo no esté cerrado ni liquidado (`PA032`); marca **todas** las facturas `pendiente` del pool como `en_mora` con `cierre_forzado = true`, `estado_final_*` como en `marcar_factura_en_mora`; devuelve `{facturas_marcadas: [ids], n}`; sin facturas asignadas devuelve `n = 0` (el reparto devuelve capital sin rendimiento ni pérdida). Añadir a `estado_reparto_pool` (redefinir con `create or replace` en esta migración) la lista de facturas con `cierre_forzado`. (depende de T028)
- [ ] T031 [US3] Extender `supabase/functions/repartir-tramo/index.ts` y `supabase/functions/_shared/reparto-pagos.ts`: con `forzar: true` (solo operador) llamar `forzar_reparto_pool` antes de la coherencia/liquidación, registrar `origen = 'forzado'` y `forzado_por`; tramo sin inversionistas → `409 PA036`; tras forzar uno de los tramos, el otro queda elegible por la regla automática de T020. (depende de T030, T026)
- [ ] T032 [US3] Aplicar `0024_forzar_reparto.sql`, desplegar `repartir-tramo`, verificar `list_migrations`/`git status`, y validar `quickstart.md` §5 (pendiente → mora por cierre forzado, `origen: forzado`, otro tramo se reparta con la misma liquidación, `403 PA008` con inversionista). (depende de T031)

**Checkpoint**: US1 + US2 + US3 funcionales.

---

## Phase 6: User Story 4 — Reloj de demo por pool (Priority: P2) — OPCIONAL para la demo

**Goal**: adelantar el tiempo de un pool sin afectar a otro; las reglas de fecha de ese pool leen su reloj.

**Independent Test**: `quickstart.md` §2 y §7 punto 3.

- [ ] T033 [US4] Crear `supabase/migrations/0025_reloj_reglas_pool.sql`: `avanzar_reloj_pool(p_pool_id uuid, p_dias int, p_horas int default 0) returns jsonb` (`security definer`, `grant execute` a `authenticated`; rol `operador_banco` → `PA008`; `p_dias * 24 + p_horas` debe ser `> 0` y `<= 366 * 24` → `PA037`; pool inexistente → `PA012`; crea la fila de `reloj_pool` si falta, suma el avance, inserta en `reloj_pool_avances`; no modifica ningún estado de negocio) y `estado_reloj_pool(p_pool_id uuid) returns jsonb` → `{ahora_real, ahora_efectivo, desplazamiento_dias, adelantado}`. (depende de T006)
- [ ] T034 [US4] En `0025`: redefinir con `create or replace` `cotizar_aporte` y `reservar_aporte`, **copiando literalmente** sus cuerpos actuales de `supabase/migrations/0008_cotizaciones_aportes.sql` (verificar antes con `grep` que ninguna migración posterior las redefinió) y cambiando solo las reglas de tiempo: `generado_at`/`expira_at = public.ahora_pool(pool_id) + interval '5 minutes'`, `reservado_at`/`expira_reserva_at = public.ahora_pool(pool_id) + interval '2 minutes'`, la comparación de vigencia de cotización contra `public.ahora_pool(v_cot.pool_id)`, y la limpieza global de reservas vencidas comparando **cada fila contra el reloj de su propio pool** (`a.expira_reserva_at < public.ahora_pool(a.pool_id)`). No tocar el tope diario de recargas (0007/0017) ni `lock_firma_stellar` (reloj real). Mantener `revoke`/`grant` idénticos. (depende de T033)
- [ ] T035 [US4] Aplicar `0025`, verificar `list_migrations`/`git status` y validar `quickstart.md` §2 (independencia entre dos pools, `PA037` con avance ≤ 0, `PA008` con inversionista, cotizar → avanzar → confirmar = `PA004`, registro de factura/recarga/aporte a otro pool sin efecto) y §7 punto 3. Comprobar además que `confirmar-aporte` sigue funcionando sin reloj adelantado (regresión). (depende de T034)

---

## Phase 7: Polish & Cross-Cutting

- [ ] T036 [P] Crear `supabase/migrations/0026_consultas_extendidas.sql` (opcional): redefinir `detalle_pool` (última versión: `0013_facturas_del_pool_y_detalle.sql`), `facturas_del_pool` y `mis_posiciones` (`0008`) **sin quitar ni renombrar campos existentes**, añadiendo `fecha_efectiva` (`ahora_pool`), `pool_vencido` (`hoy_pool >= fecha_vencimiento_esperada`), `reparto_estado` por tramo, `vencida` por factura (`hoy_pool > fecha_vencimiento`, versión anonimizada, sin proveedor ni deudor) y en `mis_posiciones` `reparto_estado`, `monto_pagado_xlm`, `pago_tx_hash` (`contracts/consultas-reparto.md`). Aplicar y verificar `git status`. (depende de T028)
- [ ] T037 [P] Agregar a `README.md` una sección hermana de "Módulo de liquidación de tramo" para este módulo: qué hace (cobro real, cascada en SQL, pagos individuales, reloj por pool), migraciones `0020`–`0026`, funciones nuevas, códigos `PA030`–`PA038`, la desviación aceptada del Principio VI (cascada no verificable on-chain), y una tabla "cuál flujo usar en la demo" frente a `liquidar-tramo` (pago real con rendimiento de facturas y mora vs. rendimiento ilustrativo con quema).
- [ ] T038 [COORD] Verificación cruzada final con la autora de `liquidacion-tramo`: (a) su `quickstart.md` completo pasa en un tramo virgen; (b) `iniciar_liquidacion_tramo` sigue rechazando con sus códigos originales salvo el caso de reparto (`PA032`); (c) actualizar `research.md` §11 con el estado final y avisarle de cualquier código o tabla nueva que pueda cruzarse con su trabajo.
- [ ] T039 Barrido de calidad: `grep -rn "PA02[0-9]" supabase/migrations/002[0-6]_*.sql supabase/functions/{cobrar-factura,marcar-factura-mora,repartir-tramo,_shared}` no debe mostrar códigos `PA021`–`PA023` de esta feature; ningún archivo nuevo > ~250 líneas sin dividir (Principio I); `git status` sin nada de `supabase/` fuera de control de versiones; ningún secreto en logs ni respuestas.
- [ ] T040 Ensayo completo de la demo con `quickstart.md` §0 y §8 (ciclo de < 3 min con 2–4 inversionistas): preparar datos con las funciones reales, cobrar, marcar una mora, ver los pagos en Horizon y en `mis_repartos()`. Anotar los hashes y los tiempos reales en `quickstart.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001–T002)**: sin dependencias; T001 [COORD] debe hacerse **primero**.
- **Foundational (T003–T006)**: bloquea todas las historias. T003, T004, T005 en paralelo; T006 tras T003.
- **US1 (T007–T018)** → **US2 (T019–T029)**: US2 usa `cobrar-factura`, `marcar-factura-mora`, `tramos.reparto_estado` y las funciones de estado de US1.
- **US3 (T030–T032)**: depende de US2 (usa `ejecutarRepartoPool` y las tablas de reparto).
- **US4 (T033–T035)**: independiente de US1–US3 salvo la base T003/T006; se puede hacer en paralelo por otra persona o dejar fuera.
- **Polish (T036–T040)**: tras las historias deseadas; T036 y T037 son [P].

### Cuidado con los conflictos entre archivos

- `0021`, `0022` y `0025` se escriben de forma secuencial (un archivo por historia): no paralelizar tareas de la misma migración.
- `supabase/functions/repartir-tramo/index.ts` y `_shared/reparto-pagos.ts` los tocan T025/T026 (US2) y T031 (US3): no editar en paralelo.
- `cobrar-factura`/`marcar-factura-mora` los tocan T015/T016 (US1) y T027 (US2).

### Parallel Opportunities

- Fase 2: T003 ‖ T004 ‖ T005.
- US1: tras T007, T008/T009/T010/T013 son secuenciales en el mismo archivo; pero **T014 (`_shared/cuenta-deudor.ts`) ‖ T016 (`marcar-factura-mora`)** en paralelo con el trabajo de SQL una vez definidas las firmas.
- US2: T024 (`0023`) ‖ T025 (`reparto-pagos.ts`) una vez definidas las firmas de T022/T023.
- US4 completo ‖ US2/US3 si hay una segunda persona (solo toca `0025` y las dos funciones de aporte).
- Polish: T036 ‖ T037.

## Implementation Strategy

### MVP para la demo del 2026-09-26 (US1 + US2)

1. T001 (coordinar) → T002 → Fase 2 (T003–T006).
2. US1 (T007–T018): cobro y mora reales. **Parar y validar.**
3. US2 (T019–T029): cascada y pagos reales. **Parar y validar; esto es la demo.**
4. Ensayar T040 con lo que haya. Si sobra tiempo: US3 (forzado), luego T037 (README), luego US4 y T036.

### Qué recortar si el tiempo aprieta (en este orden)

1. T036 y US4 (reloj): la demo funciona con reloj real.
2. US3 (forzado): se sustituye marcando cada factura como cobrada o mora.
3. `listar_pagos_reparto`/`estado_reparto_pool` de T024 (dejar solo `mis_repartos`).
4. **Nunca recortar**: T001/T021/T028/T029 (exclusión mutua y no pagar dos veces el mismo tramo) ni la regla de versionado.

## Notes

- `[P]` = archivos distintos y sin dependencia pendiente. Las tareas de migración de un mismo archivo nunca son `[P]`.
- Cada tarea de despliegue verifica `git status`; hacer commit tras cada checkpoint.
- Riesgo conocido a vigilar: el deudor único parte con ~10 000 XLM; T014 lo repone por Friendbot + fusión.
- Riesgo residual aceptado: la cascada no es verificable on-chain (Principio VI); en la presentación decir "cálculo de la plataforma", nunca "on-chain".
