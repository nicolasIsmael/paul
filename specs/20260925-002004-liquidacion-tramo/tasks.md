# Tasks: Liquidación de Tramo (Cobro Simulado, Camino Feliz)

**Input**: Design documents from `specs/20260925-002004-liquidacion-tramo/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — todos
ya generados.

**Tests**: Sin tests automatizados (Principio I; esta feature no toca el contrato Soroban, así que
ni siquiera aplica la única excepción ya establecida de `cargo test`). La validación es manual,
guiada por `quickstart.md`.

**Organización**: por historia de usuario (US1 = P1, US2 = P2, US3 = P3), igual que las 3 features
previas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (archivos distintos, sin dependencia de una tarea sin
  terminar)
- **[Story]**: a qué historia de usuario pertenece (US1/US2/US3)

## Phase 1: Setup

- [X] T001 Crear `supabase/migrations/0018_liquidacion_tramo.sql` con el encabezado estándar del
      proyecto (comentario de feature + referencia a
      `specs/20260925-002004-liquidacion-tramo/spec.md`, mismo formato que
      `0017_recargas_stellar.sql`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Propósito**: el esquema y las 4 funciones RPC de los que dependen las 3 historias de usuario.

**⚠️ CRÍTICO**: ninguna historia se puede probar hasta que esta fase esté completa.

- [X] T002 [P] En `0018_liquidacion_tramo.sql`: `alter table public.tramos add column
      estado_liquidacion text not null default 'activo' check (estado_liquidacion in ('activo',
      'liquidando', 'liquidado'))` — `data-model.md` → `tramos`.
- [X] T003 [P] En `0018_liquidacion_tramo.sql`: `create table public.liquidaciones_tramo_inversionista`
      con las columnas exactas de `data-model.md` (`id uuid primary key default gen_random_uuid()`,
      `tramo_id`/`investor_id` con sus `references`, `fracciones integer not null check
      (fracciones >= 0)`, `monto_pagado numeric(14,2) not null check (monto_pagado >= 0)`,
      `moneda text not null`, `tx_hash_pago text`, `tx_hash_quema text`, `estado text not null
      check (estado in ('pagado', 'compensado'))`, `motivo_compensacion text`, `created_at
      timestamptz not null default now()`, `unique (tramo_id, investor_id)`).
- [X] T004 En `0018_liquidacion_tramo.sql`: función `iniciar_liquidacion_tramo(p_tramo_id uuid)
      returns jsonb` — guard de rol `operador_banco` (`PA008`), `select ... for update` del tramo
      (`PA023` si no existe), rechazo si `estado_liquidacion <> 'activo'` (`PA021`), rechazo si
      existe alguna `facturas` con `tramo_id = p_tramo_id` y `estado_cobro <> 'cobrada'` (`PA022`,
      **el mensaje debe incluir los `id` de las facturas pendientes**), marca
      `estado_liquidacion = 'liquidando'`, y devuelve la lista de inversionistas con aporte
      `confirmado` en ese tramo que **todavía no tengan fila** en
      `liquidaciones_tramo_inversionista` (consulta exacta en `contracts/liquidacion-rpcs.md`).
      (depende de T002, T003)
- [X] T005 [P] En `0018_liquidacion_tramo.sql`: función `registrar_pago_liquidacion(p_tramo_id uuid,
      p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_tx_pago text,
      p_tx_quema text) returns void` — inserta con `estado = 'pagado'`,
      `on conflict (tramo_id, investor_id) do nothing`. (depende de T003)
- [X] T006 [P] En `0018_liquidacion_tramo.sql`: función `registrar_liquidacion_compensada(p_tramo_id
      uuid, p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_motivo
      text, p_tx_hash_pago text default null, p_tx_hash_quema text default null) returns void` —
      inserta con `estado = 'compensado'`, mismo `on conflict do nothing`. (depende de T003)
- [X] T007 En `0018_liquidacion_tramo.sql`: función `finalizar_liquidacion_tramo(p_tramo_id uuid)
      returns void` — `update tramos set estado_liquidacion = 'liquidado' where id = p_tramo_id and
      estado_liquidacion = 'liquidando'` (el filtro evita marcar dos veces). (depende de T002)
- [X] T008 En `0018_liquidacion_tramo.sql`: revocar privilegios directos de tabla a
      `anon`/`authenticated` sobre `liquidaciones_tramo_inversionista` — mismo patrón RLS-por-
      función que el resto del proyecto (nadie lee/escribe la tabla directamente, solo a través de
      las 4 funciones `SECURITY DEFINER`). (depende de T003)
- [X] T009 Aplicar la migración en local y verificar manualmente por SQL: los 3 valores de
      `estado_liquidacion` respetan el `check`, y las 4 funciones existen con la firma correcta.
      (depende de T002-T008)

**Checkpoint**: con la migración aplicada, las 3 historias de usuario pueden implementarse.

---

## Phase 3: User Story 1 - Liquidar un tramo con inversionistas reales (Priority: P1) 🎯 MVP

**Goal**: el operador liquida un tramo con aportes confirmados y cada inversionista recibe su pago
real + quema de fracciones.

**Independent Test**: `quickstart.md` §3 (liquidación real contra Manufactura Sur, tramo senior,
verificada de forma independiente con `stellar contract invoke`).

### Implementation for User Story 1

- [X] T010 [US1] Crear `supabase/functions/liquidar-tramo/index.ts`: validar JWT +
      `perfiles.rol = 'operador_banco'` (`service_role`, defensa en profundidad) → `403 PA008`;
      parsear `tramo_id` del body.
- [X] T011 [US1] Invocar `iniciar_liquidacion_tramo(tramo_id)` (`service_role`) y responder de
      inmediato si devuelve error (`PA021`/`PA022`/`PA023`) — **sin tocar Stellar en este camino**.
      (depende de T004, T010)
- [X] T012 [US1] Leer del tramo/pool `unidad_minima_aporte` y
      `rendimiento_ilustrativo_plazo_pct`, y `token_contract_id`; obtener el secreto de custodia del
      pool vía `obtener_secreto_custodia_pool` (RPC ya existente, reutilizado tal cual).
      (depende de T011)
- [X] T013 [US1] Implementar el bucle por cada `{investor_id, wallet_public_key}` devuelto: leer
      `fracciones = await consultarSoloLectura(token_contract_id, "balance", [wallet_public_key])`
      (reutilizar `supabase/functions/_shared/stellar-soroban.ts` tal cual) — FR-004: nunca un
      valor derivado solo de `aportes`. (depende de T012)
- [X] T014 [US1] Si `fracciones === 0`: llamar `registrar_pago_liquidacion(tramo_id, investor_id,
      0, 0, moneda, null, null)` y continuar con el siguiente inversionista sin tocar Stellar.
      Si no: calcular `monto = fracciones * unidad_minima_aporte * (1 +
      rendimiento_ilustrativo_plazo_pct / 100)` — FR-005. (depende de T013, T005)
- [X] T015 [US1] Obtener el secreto del inversionista vía `obtener_secreto_wallet` (RPC ya usada
      por `confirmar-aporte`, reutilizada tal cual) y pagar con
      `pagarXlm(secretoCustodia, wallet_public_key, monto)`
      (`supabase/functions/_shared/stellar-payment.ts`, reutilizado tal cual) — FR-006.
      (depende de T014)
- [X] T016 [US1] Invocar la quema con `invocarContratoAdminConReintentos(secretoInversionista,
      token_contract_id, "burn", [wallet_public_key, fracciones])`
      (`_shared/stellar-soroban.ts`, reutilizado tal cual firmando con el secreto del
      inversionista en vez del admin) — FR-007. (depende de T015)
- [X] T017 [US1] En éxito de T016: llamar `registrar_pago_liquidacion(tramo_id, investor_id,
      fracciones, monto, moneda, txPago, txQuema)`. (depende de T016, T005)
- [X] T018 [US1] Si T016 falla tras los 3 reintentos: revertir el pago con
      `pagarXlm(secretoInversionista, walletCustodia, monto)` (dirección inversa) y llamar
      `registrar_liquidacion_compensada(tramo_id, investor_id, fracciones, monto, moneda,
      "fallo_quema_onchain", txPago, null)` — FR-008. (depende de T016, T006)
- [X] T019 [US1] Si el propio T015 (`pagarXlm`) falla: llamar `registrar_liquidacion_compensada(
      tramo_id, investor_id, fracciones, monto, moneda, "fallo_pago_xlm", null, null)` — sin
      intentar ninguna reversión (nada que revertir todavía). (depende de T015, T006)
- [X] T020 [US1] Tras procesar (pagado o compensado) a todos los inversionistas de la lista:
      invocar `finalizar_liquidacion_tramo(tramo_id)` y responder `{ ok: true, tramo_id,
      estado_liquidacion: "liquidado", resultados: [...] }` — `contracts/liquidar-tramo-
      function.md`. (depende de T007, T017, T018, T019)
- [X] T021 [US1] Desplegar (`supabase functions deploy liquidar-tramo`) y ejecutar
      `quickstart.md` §3 contra Manufactura Sur, tramo senior — verificar con
      `stellar contract invoke ... -- balance` que el balance real bajó a 0 (no solo confiar en la
      respuesta de la función). (depende de T020)
- [ ] T022 [US1] Ejecutar `quickstart.md` §5 (fallo forzado de un inversionista, confirma FR-008 /
      SC-003) y §6 (reanudación tras interrupción, confirma la idempotencia de
      `on conflict do nothing` + el `not exists` de T004). (depende de T021)

**Checkpoint**: User Story 1 (el MVP real de esta feature) funciona de punta a punta con dinero e
inversionistas reales.

---

## Phase 4: User Story 2 - Rechazar la liquidación si falta cobrar una factura (Priority: P2)

**Goal**: el operador no puede liquidar un tramo con facturas todavía sin cobrar.

**Independent Test**: `quickstart.md` §1-2.

### Implementation for User Story 2

- [ ] T023 [US2] Validar que el mensaje de error `PA022` de `iniciar_liquidacion_tramo` (T004) trae
      la lista de `id` de facturas pendientes en el payload — es un requisito de FR-003, ya
      implementado en Foundational; esta tarea es de verificación, no de código nuevo.
      (depende de T004)
- [X] T024 [US2] Ejecutar `quickstart.md` §1 (factura sin cobrar → `PA022`) y §2 (rol incorrecto →
      `PA008`), confirmando que **ninguna fila** se crea en `liquidaciones_tramo_inversionista` ni
      cambia `tramos.estado_liquidacion` en ningún caso. (depende de T011, T023)

**Checkpoint**: User Stories 1 y 2 funcionan juntas sin interferirse.

---

## Phase 5: User Story 3 - Liquidar un tramo sin ningún aporte confirmado (Priority: P3)

**Goal**: un tramo sin inversionistas se puede cerrar administrativamente.

**Independent Test**: `quickstart.md` §4.

### Implementation for User Story 3

- [ ] T025 [US3] Validar que la consulta de `iniciar_liquidacion_tramo` (T004) devuelve
      `inversionistas: []` cuando no hay ningún aporte `confirmado` en el tramo — verificación, no
      código nuevo (ya cubierto por el `select distinct` de T004). (depende de T004)
- [ ] T026 [US3] Confirmar que el bucle de `liquidar-tramo/index.ts` (T013-T019) maneja una lista
      vacía sin error y llega directo a T020 (`finalizar_liquidacion_tramo`) — FR-009.
      (depende de T020, T025)
- [X] T027 [US3] Ejecutar `quickstart.md` §4 contra un tramo sembrado sin aportes confirmados.
      (depende de T026)

**Checkpoint**: las 3 historias de usuario funcionan de forma independiente y en conjunto.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T028 [P] Actualizar `specs/20260925-002004-liquidacion-tramo/checklists/requirements.md` si
      algo cambió respecto al `spec.md` original durante la implementación.
- [X] T029 Autoevaluación contra los 7 principios de la constitución (Principio I) antes de
      integrar a `main` — en particular Principio VI (¿el pago se calculó sobre `balance()` real en
      los 3 escenarios probados?) y Principio VII (¿toda la migración y la función viven en
      `/supabase`, nada aplicado desde el dashboard?).
- [X] T030 Documentar en el `README.md` del proyecto (sección "Estado real de esta feature", mismo
      patrón que las 3 specs previas) qué se construyó y las exclusiones explícitas de alcance:
      mora, pago parcial, waterfall real entre tramo senior/junior, y liquidación a nivel de
      factura individual.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup — **bloquea las 3 historias de usuario**.
- **User Stories (Phase 3-5)**: todas dependen de Foundational. US2 y US3 dependen además de que
  exista `liquidar-tramo/index.ts` (T010-T011, T020) para poder ejecutarse de punta a punta, pero
  no agregan código nuevo a esa función — solo la validan en sus propios escenarios.
- **Polish (Phase 6)**: depende de que US1 (mínimo) esté completa.

### User Story Dependencies

- **User Story 1 (P1)**: la única con implementación nueva real de la Edge Function. Es el MVP.
- **User Story 2 (P2)**: reutiliza el guard ya construido en T004/T011 — solo agrega verificación.
- **User Story 3 (P3)**: reutiliza el camino de lista vacía ya construido en T004/T020 — solo
  agrega verificación.

### Parallel Opportunities

- T002 y T003 (Foundational) se pueden escribir en paralelo — columnas distintas de objetos
  distintos dentro del mismo archivo de migración.
- T005 y T006 se pueden escribir en paralelo entre sí (funciones independientes) una vez que T003
  exista.
- T028 (Polish) se puede hacer en paralelo con T029/T030.

---

## Implementation Strategy

### MVP First (User Story 1 solamente)

1. Completar Phase 1 (Setup) y Phase 2 (Foundational) — sin esto no hay nada que probar.
2. Completar Phase 3 (User Story 1) — es el MVP real: el ciclo completo de inversión por fin cierra
   con un pago real de vuelta al inversionista.
3. **Parar y validar** con `quickstart.md` §3, §5 y §6 antes de seguir.
4. Si el tiempo apremia, US2 y US3 son las siguientes en cortarse por ser las de menor esfuerzo
   (son casi enteramente verificación de comportamiento ya construido en Foundational) — no
   requieren código nuevo, así que rara vez serán el cuello de botella.

### Incremental Delivery

1. Foundational listo → nada visible todavía, pero la base es segura.
2. User Story 1 → demo real de liquidación con inversionistas (MVP).
3. User Story 2 → confirma que el sistema protege contra liquidar antes de tiempo.
4. User Story 3 → confirma que ningún tramo (ni siquiera uno vacío) queda imposible de cerrar.

## Notes

- [P] = archivos u objetos distintos, sin dependencia de una tarea sin terminar.
- La etiqueta [Story] solo aplica a las fases 3-5; Setup, Foundational y Polish no llevan etiqueta.
- Sin tests automatizados nuevos (Principio I) — cada checkpoint se valida manualmente contra
  `quickstart.md`, igual que las 3 features previas del proyecto.
