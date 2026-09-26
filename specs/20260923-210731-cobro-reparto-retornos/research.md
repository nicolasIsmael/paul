# Research: Cobro de Facturas, Reparto de Retornos y Reloj de Demo

Investigación previa al diseño. Fuentes: código real del repo (`contracts/soroban-pool`,
migraciones 0001–0017, Edge Functions existentes), estado real del proyecto Supabase
(`qqpozotcrxfukkwcoget`, consultado por MCP) y documentación oficial de Stellar (MCP de
Stellar/Soroban). Ningún NEEDS CLARIFICATION quedó abierto.

## 1. ¿Participa el contrato Soroban existente en el reparto? (paso obligatorio)

**Hallazgos** (lectura de `contracts/soroban-pool/src/lib.rs`, 296 líneas):

- Expone SEP-41 completa: `balance`, `transfer`, `approve`, `allowance`, `burn`, `decimals`,
  `name`, `symbol`, más `initialize`, `set_admin`, `register_invoice`, `mint`, `cap`,
  `total_supply`.
- `burn(from, amount)` existe pero exige `from.require_auth()` — la plataforma podría firmarlo con
  la llave custodial del inversionista. **No se usa**: la spec deja explícitamente fuera de
  alcance la quema tras el reparto ("quedan como registro histórico de participación").
- `transfer` existe (SEP-41) pero mueve **fracciones**, nunca XLM. El contrato "nunca conoce montos
  monetarios" (cabecera del propio archivo).
- **No hay función de liquidación, ni de custodia de fondos, ni de upgrade**: no existe
  `update_current_contract_wasm`; solo `set_admin`. `contracts/deployments/testnet.json` lista 12
  instancias vivas (6 pools × 2 tramos) con fracciones ya emitidas.

**Rutas evaluadas**

| Ruta | Descripción | Veredicto |
|------|-------------|-----------|
| A (**elegida, 2026-09-25**) | El contrato queda como emisor histórico; cascada, prorrateo e irreversibilidad en Postgres; pagos nativos reales vía Horizon | La más simple y de menor riesgo de plazo para la demo del 2026-09-26. **Desviación aceptada del Principio VI**: la cascada no es verificable on-chain (ver Complexity Tracking en `plan.md`). |
| B | Extender `pool_fraction_token` con `liquidar`/`distribuir` | **Inviable**: sin ruta de upgrade habría que redesplegar 12 instancias y volver a emitir todas las fracciones. |
| C (descartada por plazo) | Contrato nuevo `pool_settlement` (cascada + bloqueo de liquidar/cerrar dos veces), pagos nativos desde Horizon | Cumple VI, pero añade un crate Rust, pruebas, despliegue y cableado de tres funciones a un día de la presentación. Queda como mejora posterior; el diseño de la cascada (`perdida_junior = min(perdida, capital_junior)`, `perdida_senior = min(perdida − perdida_junior, capital_senior)`) se conserva tal cual en SQL para poder migrarlo. |

**Decisión**: Ruta A.

- `pool_fraction_token` **no participa**: ni burn, ni transfer, ni ninguna escritura. Solo una
  lectura de coherencia: antes de pagar un tramo se compara `total_supply` on-chain con la suma de
  fracciones de los aportes confirmados en Postgres; si difieren, el reparto se aborta (FR-027 de
  la spec previa: el contrato es la fuente de verdad).
- La cascada senior/junior, el prorrateo y la regla "un reparto por tramo" viven en funciones SQL y
  en restricciones únicas (`unique(repartos_tramo.tramo_id)`), no en un contrato.
- **Qué sí es evidencia on-chain real**: cada cobro (deudor → custodia) y cada pago (custodia →
  inversionista) es una transacción nativa con hash verificable en Horizon, y las fracciones siguen
  emitidas en el contrato. **Qué no lo es**: el resultado de la cascada. En la presentación debe
  describirse como cálculo de la plataforma.

## 2. Agrupar pagos (decisión 3): ¿varias operaciones por transacción o una por inversionista?

**Hallazgos** (documentación oficial de Stellar vía MCP):

- Una transacción clásica admite **hasta 100 operaciones**, y el fee de inclusión es
  `operaciones × fee base`. Se pueden meter N operaciones `payment` en un mismo sobre.
- Una transacción con operación Soroban (`InvokeHostFunction`, `ExtendFootprintTTL`,
  `RestoreFootprint`) **solo puede contener una operación** — no se pueden mezclar pagos nativos
  con la invocación del contrato en la misma transacción.
- Una transacción con varias operaciones es **atómica**: si una falla (p. ej. cuenta destino
  inexistente o sin trustline), fallan todas.

**Decisión: una transacción de pago independiente por inversionista.**

| Criterio | Un sobre con N pagos | Una transacción por inversionista (elegida) |
|----------|---------------------|---------------------------------------------|
| Cumple FR-020 de la spec ("una sola transacción por inversionista") | ❌ el hash sería compartido | ✅ |
| Estado por inversionista (decisión 4) | ❌ atómico: no puede haber "pagado a unos y fallido a otros" dentro del sobre | ✅ cada pago tiene hash y estado propios |
| Aislamiento de fallos | ❌ un destino defectuoso tumba a todos | ✅ |
| Depuración/evidencia en demo | ❌ un hash para todos | ✅ un hash verificable por inversionista |
| Costo | ~N×fee base menos overhead | N×100 stroops = trivial en testnet |
| Latencia | 1 cierre de ledger | N × ~5 s (mitigado en §5) |

La eficiencia del sobre único no compensa perder granularidad de reintento, que es un requisito
explícito. Se documenta como decisión reversible: si un caso real necesitara cientos de
inversionistas por tramo, se puede agrupar en sobres de ≤ 100 operaciones sin cambiar el modelo
de datos (bastaría compartir `tx_hash` entre pagos).

## 3. Reloj simulado por pool (decisión 2)

**Inventario real de reglas dependientes de `now()`/`current_date`** (grep sobre `supabase/`):

| Regla | Dónde | Alcance de pool | Tratamiento |
|-------|-------|-----------------|-------------|
| Vigencia de cotización (5 min) | 0008 `cotizar_aporte`/`reservar_aporte`, default `expira_at` | Sí (`cotizaciones.pool_id`) | Lee `ahora_pool(pool_id)` |
| Vigencia de reserva de aporte (2 min) y su limpieza global | 0008 `reservar_aporte` | Sí (`aportes.pool_id`) | Limpieza por fila contra el reloj **de su propio pool** |
| Tope diario de recargas (día Lima) | 0007/0017 | **No** (es del inversionista, sin pool) | **Reloj real** — no es una regla de pool; la spec exige que las recargas sigan normales |
| Lock de firma Stellar | 0016 | No (técnico) | **Reloj real siempre** (FR-035) |
| Fechas por defecto de facturas (`current_date`) | 0011 | No (valor por defecto de columna, el operador envía fechas explícitas en `registrar_factura`) | Sin cambios |
| Vencimiento de factura y de pool | **no existe hoy** como regla evaluada; solo columnas `fecha_vencimiento`, `fecha_vencimiento_esperada` | Sí | Se introduce lectura por pool: `vencida`/`pool_vencido` expuestas en las consultas (§ data-model) |
| Fecha del cobro y del reparto | nuevas | Sí | Se guarda la **fecha efectiva del pool** junto a la fecha real de auditoría |

**Decisión**:

- Tabla `reloj_pool(pool_id, desplazamiento interval)`; función `ahora_pool(pool_id) =
  now() + coalesce(desplazamiento, '0')`; `hoy_pool` = fecha en `America/Lima` de ese instante.
  Un pool sin fila tiene desplazamiento cero → el sistema se comporta exactamente como hoy.
- **Las ventanas de validez se guardan en tiempo efectivo del pool** (`expira_at = ahora_pool +
  5 min`, comparadas contra `ahora_pool`). Así una cotización creada con el reloj adelantado sigue
  vigente 5 minutos y solo caduca si el operador vuelve a adelantar el reloj de ese pool.
  Consecuencia buscada y documentada: al avanzar el reloj de un pool, sus cotizaciones/reservas
  pendientes caducan — la limpieza de `reservar_aporte` libera cupo y saldo con la misma
  contabilidad de hoy.
- El reloj **solo avanza** (`avanzar_reloj_pool` rechaza avances ≤ 0) y tiene tope por llamada
  (366 días) para evitar desbordes accidentales. Cada avance queda en `reloj_pool_avances`.
- **Auditoría técnica** (`created_at`, `confirmado_at`, `revertido_at`, hashes on-chain) sigue con
  `now()` real (FR-035); las columnas nuevas `*_efectivo_at` guardan el tiempo del pool.
- "Por sesión de demo" (alternativa mencionada en el plan de entrada) se descarta: no existe
  concepto de sesión en el modelo, agregarlo cuesta una tabla y un parámetro en cada llamada; el
  pool ya es la unidad que se muestra en paralelo.

**Divergencia con la spec**: `spec.md` (FR-027–FR-033, Historia 4) describía un reloj **global**;
este plan lo cambia a **por pool** por decisión explícita del equipo. La spec se ajusta en el mismo
paso (ver nota al final de `spec.md` → Clarifications).

## 4. Cuenta deudor única (decisión 1) — y el límite del Friendbot

- Una fila `cuenta_deudor_demo` (singleton, secreto en Vault, mismo patrón que
  `tesoreria_stellar_demo`, 0017). Provisión **perezosa e idempotente** desde `cobrar-factura`:
  genera keypair, `pg_advisory_xact_lock`, guarda el secreto en Vault, llama a Friendbot **una vez**.
- **Hallazgo de riesgo**: Friendbot entrega ~10 000 XLM por cuenta nueva. Con el tipo de cambio
  demo (`0.36` PEN por XLM) una factura de S/2 000 equivale a ~5 555 XLM y una de S/3 200 a ~8 889
  XLM: **una sola cuenta con 10 000 XLM no alcanza para cobrar más de una o dos facturas**.
- **Decisión**: cuando el saldo no cubre un cobro, `cuenta-deudor.ts` repone **únicamente vía
  Friendbot**: crea una cuenta efímera, la fondea con Friendbot y la fusiona
  (`Operation.accountMerge`) en la cuenta deudor — todos sus XLM pasan a la cuenta deudor. La
  identidad de pagador sigue siendo una sola cuenta (cumple la decisión 1: no hay wallet por
  factura; las efímeras no pagan nada, solo reponen). Hasta 3 reposiciones por cobro; si aun así
  no alcanza → `PA033` (fondos del deudor insuficientes) y la factura queda `pendiente`.
- Alternativa descartada: reponer desde `tesoreria_stellar_demo` — mezcla fondos de dos roles y
  puede agotar la tesorería que financia recargas de inversionistas.

## 5. Flujo de cobro y garantías de idempotencia

Patrón ya probado en el repo (recargas 0017 y `asignar-factura`): **reservar en Postgres →
mover dinero on-chain → confirmar**, con la transacción preparada y su hash guardados **antes** de
enviarse, de modo que un fallo intermedio se reconcilia consultando Horizon sin volver a pagar.

1. `iniciar_cobro_factura` bloquea la fila de la factura (`FOR UPDATE`), valida
   (`asignada`, `pendiente`, tramo sin reparto cerrado) y crea `cobros_factura` en `reservado`.
   Un **índice único parcial** (`factura_id` donde `estado in ('reservado','confirmado')`) hace
   imposible un segundo cobro concurrente (FR-007), sin depender de la disciplina del cliente.
2. La Edge Function prepara el pago deudor → custodia (memo `cobro:<id>`), guarda `tx_hash`+
   `tx_xdr`, y lo envía bajo `conLockFirma(cuentaDeudor)`.
3. Éxito → `confirmar_cobro_factura` (factura → `cobrada`). Error ambiguo (timeout) →
   `existeTransaccion(hash)`: si existe, confirma; si no, `fallar_cobro_factura` (el cobro pasa a
   `fallido`, libera el índice, la factura sigue `pendiente`) y se puede reintentar (FR-008/FR-009).
4. Un cobro `reservado` con `tx_xdr` guardado que se reintenta **reenvía el mismo XDR** o lo
   concilia; jamás construye un pago distinto.

Monto: `monto_xlm = round(monto_nominal / tasa_moneda_por_xlm, 7)` con la tasa vigente al cobro
(guardada en `cobros_factura.tipo_cambio_aplicado`).

## 6. Cascada senior/junior y cálculo de pagos

Reglas **ya clarificadas** (spec, sesión 2026-09-23) — no se rediseñan:

- Capital y pagos en XLM; el capital devuelto es `aportes.xlm_pagados` de cada inversionista.
- El rendimiento de una factura cobrada (`monto_nominal − anticipo`, en moneda del pool) se queda
  en **su propio tramo**; jamás pasa al otro. Se convierte a XLM con la tasa vigente **al
  reparto** (`liquidaciones_pool.tipo_cambio_aplicado`, fijada una sola vez por pool).
- La pérdida por mora (`anticipo` de cada factura en mora, de **cualquier** tramo) se acumula a
  nivel de pool, se convierte con la misma tasa y la absorbe primero el junior (cascada en el
  contrato). El senior solo absorbe el exceso sobre el capital total del junior.

**Por qué el reparto automático espera a todo el pool** (ya en la spec): la pérdida de una factura
del senior la absorbe el junior; pagar al senior antes de conocer todas las pérdidas produciría un
resultado dependiente del orden.

Prorrateo (en SQL, `crear_pagos_reparto`), por inversionista `i` en el tramo `t`:

```
fracciones_i   = Σ aportes confirmados (monto_nominal / unidad_minima_pool)
neto_t         = rendimiento_t_xlm − perdida_absorbida_t_xlm         (puede ser negativo)
pago_i         = max(0, floor7( capital_i + neto_t × fracciones_i / Σ fracciones_t ))
```

- Todo en `numeric(20,7)` (precisión de XLM); redondeo **hacia abajo** por pago: el polvo se
  queda en la custodia y la suma de pagos nunca supera lo asignado por la cascada (FR-015).
- Si el `max(0, …)` elevara la suma por encima de `capital_t + rendimiento_t − perdida_absorbida_t`
  (posible solo con tasas de aporte muy distintas entre inversionistas), se aplica un factor de
  escala uniforme a los pagos de ese tramo antes de guardarlos; el contrato lo verifica al cerrar.
- **Coherencia con la cadena**: `Σ fracciones_t` (Postgres) debe igualar
  `total_supply` del contrato del tramo; si no, el reparto se aborta antes de crear pagos.

**Artefacto contable de la demo (se documenta, no se corrige)**: en el sistema actual el
anticipo **nunca sale de la custodia** hacia el proveedor (no hay flujo on-chain de desembolso).
Por eso, tras cobrar el nominal completo, la custodia queda con un excedente ≈ suma de anticipos
cobrados sobre lo que se reparte. No afecta la correctitud de los pagos (la custodia siempre
alcanza) y FR-016 lo cubre; un desembolso al proveedor está fuera de alcance.

**Reserva mínima de la cuenta**: antes de repartir se exige `saldo_custodia − 1.5 XLM ≥ pagos
pendientes de este tramo + pagos comprometidos del otro tramo del pool`; si no, `PA035` con el
faltante y ningún pago se ejecuta (FR-016).

## 7. Ejecución del reparto y estado parcial (decisión 4)

- Estados de `pagos_reparto`: `pendiente` → `pagado` | `fallido`; `fallido` vuelve a
  `pendiente` al reintentar. Restricción única `(reparto_id, investor_id)`: **un inversionista
  no puede tener dos pagos en el mismo reparto** aunque el código tenga un bug de concurrencia.
- Cada pago guarda `tx_hash` + `tx_xdr` **antes** de enviarse (mismo patrón que §5). Reintento:
  si el pago ya tiene hash y `existeTransaccion` es verdadero → marcar `pagado` sin pagar de
  nuevo; si no existe → reenviar el mismo XDR (o reconstruir si ya expiró el timeout de 60 s).
  La consulta a Horizon es la fuente de verdad ante la duda.
- El tramo pasa a `cerrado` **solo cuando el 100 % de sus pagos está `pagado`**: entonces
  `cerrar_reparto_tramo` en Postgres marca el tramo `cerrado` (irreversible). No hay paso
  on-chain de cierre.
- **Límite de tiempo de una Edge Function**: los pagos son secuenciales por la secuencia de la
  cuenta (`conLockFirma`), ~5–6 s cada uno. La función procesa pagos hasta un presupuesto de
  ~100 s por invocación y devuelve `pagos_restantes`; el cliente (o el propio operador) vuelve a
  invocar `repartir-tramo` hasta 0. Para la demo (2–4 inversionistas por tramo) cabe en una
  invocación. No se introduce cola ni cron: fuera de proporción para la semana.
- Concurrencia: el disparo automático, el reparto forzado y un reintento comparten el mismo
  candado — `pg_advisory_xact_lock(hash(tramo_id))` al crear el reparto y `unique(tramo_id)` en
  `repartos_tramo` (FR-023).

## 8. Reparto forzado y facturas pendientes (Clarificación de la spec)

Al forzar, las facturas `pendiente` **del pool** se marcan `en_mora` con `cierre_forzado = true`
en una sola transacción, con su anticipo contado como pérdida. Después el flujo es idéntico. Es
convención de demo (la spec ya lo dice); no se modela recuperación posterior.

## 9. Seguridad, roles y acceso

- Tablas nuevas: RLS habilitada, `revoke all` a `anon`/`authenticated`, acceso solo por funciones
  (mismo patrón que 0003/0011/0017).
- Funciones que mueven estado (`iniciar_cobro_factura`, `confirmar_*`, `crear_pagos_reparto`…):
  solo `service_role`; las Edge Functions validan JWT + `perfiles.rol = 'operador_banco'` antes de
  llamar (defensa en profundidad, igual que `asignar-factura`).
- Lecturas de operador (`estado_reparto_pool`, `listar_pagos_reparto`, `estado_reloj_pool`,
  `avanzar_reloj_pool`) verifican `auth.uid()` = operador dentro de la función; lecturas de
  inversionista (`mis_repartos`) devuelven solo `auth.uid()`.
- **Camino manual legado que NO se cierra (cambio 2026-09-25)**: `actualizar_estado_cobro_factura`
  (0013) permite al operador poner cualquier estado en una factura asignada, sin dinero. El plan
  original la revocaba de `authenticated`, pero la spec paralela `liquidacion-tramo` **depende de
  ella** para marcar `cobrada` en su demo, así que se conserva. Consecuencia conocida: por ese
  camino una factura puede quedar `cobrada` sin `cobros_factura` (incumple FR-003 en ese camino).
  El trigger de guardia `facturas_guardia_estado_cobro` sí se agrega, pero solo restringe lo que
  no rompe ese flujo: impide `cobrada|en_mora → otro` y cambios de estado en tramos ya repartidos.
  Cerrar el camino manual queda como tarea posterior a la demo.
- Hallazgo del asesor de Supabase (preexistente, no de esta feature): `public.lock_firma_stellar`
  tiene RLS deshabilitado. Es la tabla que serializa firmas — se corrige en 0021 (RLS + `revoke`
  a `anon`/`authenticated`; el acceso real es por las RPC `adquirir/liberar_lock_firma`, que son
  `security definer`).

## 10. Despliegue versionado (petición explícita del usuario)

- Migraciones aplicadas con Supabase CLI (`supabase db push`) o MCP `apply_migration` **a partir
  del archivo del repo** — nunca contenido escrito solo en la llamada. Los nombres remotos ya
  divergen de los locales (p. ej. `0016` remoto quedó como `20260923015716`); las nuevas usan el
  mismo prefijo numérico local y se comprueba con `list_migrations` tras aplicar.
- Edge Functions con `supabase functions deploy <nombre>` desde `/supabase/functions`.
- Regla de cierre de cada tarea: `git status` sin archivos de `supabase/` fuera de control de
  versiones. Las migraciones locales `0018`/`0019` (spec `liquidacion-tramo`) ya están aplicadas en
  remoto: las nuestras empiezan en `0020`.

## 11. Coexistencia con la spec `liquidacion-tramo` (2026-09-25)

Otra persona del equipo implementó y aplicó en remoto un cierre de tramo distinto
(`specs/20260925-002004-liquidacion-tramo`). Diferencias que importan para no cometer errores:

| | `liquidacion-tramo` (existente) | Esta feature |
|--|--------------------------------|--------------|
| Pago | capital + `rendimiento_ilustrativo_plazo_pct` del tramo | capital (`xlm_pagados`) + rendimiento real de facturas (`nominal − anticipo`) − pérdida absorbida |
| Facturas requeridas | 100 % `cobrada` (sin mora) | todas en estado final, o forzado |
| Mora / cascada | fuera de alcance | núcleo de la feature |
| Fracciones | las quema (`burn` firmado por el inversionista) | no las toca |
| Estado terminal | `tramos.estado_liquidacion = 'liquidado'` | `tramos.reparto_estado = 'cerrado'` |
| Cómo se marca `cobrada` | `actualizar_estado_cobro_factura` (manual) | `cobrar-factura` (transferencia real) |
| Códigos de error | `PA021`–`PA023` | `PA030`–`PA039` |
| Migraciones | `0018`, `0019` | `0020`–`0023` |

Garantía necesaria: **un tramo no puede cerrarse por los dos mecanismos** (ambos pagan desde la
misma custodia). Se implementa con exclusión mutua en ambas direcciones (ver `plan.md`). Ambas
lecturas de estado deben tomar `FOR UPDATE` sobre la fila del tramo para que dos inicios
simultáneos no pasen a la vez.
