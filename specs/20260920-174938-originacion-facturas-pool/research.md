# Research: Originación de Facturas y Tokenización de Fracciones de Pool

Investigación y decisiones de arquitectura para las 4 preguntas planteadas explícitamente por el
usuario, más las decisiones derivadas que exige integrar un contrato Soroban con el backend
Supabase ya construido (specs `20260919-131233-auth-perfil-usuario` y
`20260920-113925-inversion-pools-aporte`). Todo lo verificado abajo se contrastó contra la
documentación oficial de Soroban/Stellar (skills `smart-contracts`, `assets`, `standards`) y contra
el código real ya desplegado en este repositorio (migraciones, Edge Functions).

## 1. Mapeo del "tramo" a un token SEP-41 concreto

**Decisión**: **una sola crate/WASM (`contracts/soroban-pool`), instanciada UNA VEZ POR TRAMO**.
Cada tramo (`senior`/`junior` de cada pool) obtiene su propia instancia de contrato con su propio
almacenamiento — es decir, "un contrato por tramo" en términos de identidad on-chain, pero "un solo
código fuente" en términos de mantenimiento. El contrato implementa la interfaz completa de token
SEP-41 (`balance`, `transfer`, `approve`, `allowance`, `burn`, `decimals`, `name`, `symbol`) más dos
extensiones administrativas propias: `register_invoice` (registrar la huella de una factura y el
nuevo cupo) y `mint` (emitir fracciones a un inversionista, con cupo máximo).

**Por qué NO "un contrato con dos tokens"**: el patrón idiomático de Soroban para un token
fungible es "un contrato = un activo" (así lo implementa el propio Stellar Asset Contract y el
ejemplo oficial `token` de `soroban-examples`). Meter senior y junior en un único contrato exigiría
una interfaz no estándar (`balance(tramo, address)` en vez de `balance(address)`), lo que rompe la
compatibilidad SEP-41 y con ella cualquier herramienta genérica de exploración de tokens Soroban
que un jurado pudiera usar para verificar el proyecto de forma independiente (requisito de
`README`/evidencia verificable). Desplegar el mismo WASM dos veces por pool (una vez por tramo) es
barato en testnet y mantiene cada tramo como un activo SEP-41 de primera clase.

**Mapeo de unidades — decisión central que simplifica todo lo demás**: el token se declara con
`decimals = 0`. **1 unidad de token = 1 fracción = 1 `unidad_minima_aporte` del pool** (en soles o
dólares). El contrato nunca conoce montos monetarios ni la unidad mínima — solo maneja enteros
(`i128`) de fracciones. Toda la conversión monto↔fracciones ocurre en Postgres (que sí conoce
`unidad_minima_aporte`), exactamente igual que hoy Postgres ya valida que un aporte sea múltiplo de
esa unidad antes de cotizar (`cotizar_aporte`, `PA001`). Esto mantiene el contrato mínimo (menor
superficie de auditoría, más rápido de construir dentro del plazo del hackatón) y evita duplicar la
aritmética monetaria en dos lenguajes (SQL y Rust).

**Quién es el administrador/emisor**: **una única autoridad de plataforma por red** (`testnet`),
no una cuenta del operador de banco individual. `perfiles` (spec de auth) ya modela que solo el rol
`inversionista` tiene wallet propia (`wallet_fields_solo_inversionista`); `operador_banco` nunca
tiene una wallet Stellar personal. Igual que la custodia de cada pool ya es una cuenta controlada
por la plataforma (no por un inversionista), la autoridad admin de los contratos es **otra cuenta
más controlada por la plataforma**, generada y fondeada una sola vez por el script de despliegue,
custodiada en Vault con el mismo mecanismo que las wallets de inversionista y las custodias de
pool. Es esta autoridad — nunca una cuenta personal — la que firma `register_invoice` y `mint` en
nombre de "el operador" cada vez que una acción de negocio del operador de banco lo exige. La
autenticación de negocio (¿es realmente un `operador_banco`?) ya la hacen las funciones RPC de
Postgres (`rol = 'operador_banco'`); el contrato solo necesita saber que la llamada viene firmada
por esa única autoridad — es una capa de autorización, no de autenticación de usuarios finales.

**Alternativas descartadas**:

- *Un contrato "registry" global + N contratos de token*: añade una segunda superficie de
  contrato y una llamada cross-contract adicional por cada registro de factura, sin beneficio real
  dado que cada tramo ya es una unidad de aislamiento natural (cupo y facturas nunca se comparten
  entre tramos). Se descarta por complejidad innecesaria para el plazo del hackatón.
- *Fracciones como registro interno de saldos dentro del propio contrato sin interfaz SEP-41*: es
  la alternativa que la propia spec dejaba abierta como aceptable (`Assumptions` de `spec.md`). Se
  descarta en favor de SEP-41 completo porque el costo adicional es bajo (el ejemplo oficial de
  token ya cubre el 90% del código) y el beneficio — verificabilidad con herramientas genéricas de
  Soroban, sin depender de la plataforma — es exactamente el requisito no negociable del Principio
  VI de la constitución.

## 2. El contrato como fuente de verdad y compensación ante fallo a mitad de camino

**Decisión confirmada por el usuario**: el contrato manda. Un aporte solo se confirma en Supabase
**después** de que el contrato registró las fracciones. Orden extendido de `confirmar-aporte`:

```
reservar (Postgres, ya existente) -> pagar XLM a la custodia del pool (Horizon, ya existente)
  -> emitir fracciones en el contrato del tramo (Soroban, NUEVO)
  -> confirmar (Postgres, ya existente)
```

**El caso difícil**: el pago en XLM ya se ejecutó (dinero real de testnet ya en la custodia del
pool) y el paso de contrato falla. Revertir la reserva de Postgres (`revertir_aporte`, ya existe)
es gratis y ya funciona — pero **no deshace el pago en XLM**, que la plataforma sí puede deshacer
porque controla ambas llaves (la del inversionista y la de la custodia del pool son wallets
custodiadas, nunca del lado del cliente).

**Decisión**: **reintento acotado + compensación automática**, nunca dejar el aporte pendiente
(mantiene FR-034 de la spec previa, que esta feature no reabre):

1. Al fallar la llamada al contrato (red, timeout, error de simulación), reintentar hasta 2 veces
   más (3 intentos totales) con backoff corto (1s, luego 2s) — cubre el caso común de un timeout
   transitorio de Soroban RPC o de una congestión de ledger.
2. Si los 3 intentos fallan, o el contrato rechaza la llamada de forma definitiva (p. ej.
   `CapExceeded` — ver más abajo por qué esto casi nunca debería pasar), la Edge Function **paga
   una transacción compensatoria**: XLM desde la custodia del pool de vuelta a la wallet del
   inversionista, por el monto exacto ya pagado, firmada con la misma llave de custodia del pool
   (misma mecánica que el pago original, solo invertida). Solo después de que esa compensación se
   somete con éxito, se llama `revertir_aporte(aporte_id, 'fallo_emision_fracciones')` (nuevo
   valor de enum) y se responde `ok:false` con `PA019` — el resultado final sigue llegando en la
   misma solicitud, nunca "pendiente".
3. Si incluso la compensación falla (Horizon no disponible dos veces seguidas — escenario
   extremadamente improbable en testnet durante una demo corta), la función devuelve `ok:false`
   con un código que exige intervención manual (reutiliza `PA013`) y dos hashes de intento quedan
   registrados para diagnóstico (`aportes.tx_hash` ya pagado, más el intento de reembolso en logs
   de la función) — aceptado como límite conocido, documentado en la sección de riesgos de
   `plan.md`, dado el plazo del hackatón.

**Por qué el contrato "casi nunca" debería rechazar el mint por cupo**: Postgres ya valida y
reserva el cupo monetario de forma atómica en `reservar_aporte` (UPDATE condicional, ver
`research.md` de la spec previa §1) antes de que la Edge Function llegue siquiera a tocar Stellar;
el cupo en fracciones del contrato (`cap`) se mantiene sincronizado 1:1 con `capital_objetivo /
unidad_minima_aporte` de Postgres por construcción (§4 más abajo). El único caso realista en el que
el contrato rechace un `mint` por cupo es una condición de carrera entre la actualización de
`tramos.capital_objetivo` (cuando el operador asigna una nueva factura) y un aporte concurrente —
un caso de borde documentado y aceptado en la sección de riesgos, no un fallo de diseño.

**Idempotencia — el mismo `idempotency_key` nunca emite fracciones dos veces**: se garantiza en dos
capas independientes (defensa en profundidad):

- **Capa Postgres (ya existente)**: `reservar_aporte` es idempotente por `(investor_id,
  idempotency_key)` — un reintento del mismo `idempotency_key` devuelve el aporte ya existente
  (`ya_existia: true`) sin volver a reservar cupo ni saldo.
- **Capa contrato (nueva)**: `mint` no recibe el `idempotency_key` directamente (el contrato no
  conoce ese concepto), pero la Edge Function solo invoca `mint` **una vez por `aporte_id`**,
  gracias a una nueva columna `aportes.fraccion_tx_hash`: antes de invocar el contrato, la función
  comprueba si ese aporte ya tiene `fraccion_tx_hash` (si `reserva.ya_existia = true` **y** ya hay
  un `fraccion_tx_hash` registrado, la función devuelve el resultado ya conocido sin volver a
  mintear — mismo patrón que el "reintento/doble clic" ya resuelto para el pago XLM). Esto cierra
  la única ventana real: un reintento de red del propio cliente después de que el mint ya se
  ejecutó pero antes de que la respuesta HTTP llegara.

## 3. Comisiones, activación de cuentas y TTL en Soroban con wallets custodiadas

**Hallazgos**:

- **Fees**: toda invocación al contrato (incluida la simulación) cobra un fee en XLM a la cuenta
  que firma y somete la transacción — en este diseño, siempre la **autoridad de plataforma**
  (nunca el inversionista ni el operador). Esa cuenta se funda una sola vez vía Friendbot (10,000
  XLM de testnet, igual que cualquier otra cuenta de este proyecto) — margen amplio para el volumen
  de una demo de hackatón (decenas de invocaciones).
- **Activación de cuentas**: a diferencia de un activo clásico de Stellar (`Asset` + trustline), un
  balance de un token Soroban (SEP-41) **no exige que la cuenta destino exista fondeada ni tenga
  trustline alguna** — el balance vive en el almacenamiento del propio contrato, direccionado por
  cualquier `Address` válida. La wallet del inversionista (ya fondeada por Friendbot desde la
  feature de registro) recibe fracciones sin ningún paso adicional de activación.
- **Límites de recursos**: cada invocación debe respetar los límites de instrucciones/memoria/
  lectura-escritura de ledger que Soroban impone por transacción; el SDK calcula esto
  automáticamente vía `server.prepareTransaction()` (simula la invocación contra el RPC y rellena
  el footprint + fee de recursos exactos) — nunca se fija a mano, evitando fallos por
  subestimación.
- **TTL / archivado de estado**: toda entrada de almacenamiento persistente en Soroban (incluida la
  instancia del propio contrato) tiene un TTL (`live_until_ledger`) que, si expira, la archiva
  (el contrato deja de ser invocable hasta restaurarla con una operación adicional). **Riesgo real
  para una ventana de hackatón de ~5 días**: mitigado extendiendo el TTL de la instancia y de las
  entradas persistentes clave (`Admin`, `Cap`, balances) al máximo permitido en cada
  `initialize`/`register_invoice`/`mint` (`extend_ttl` dentro del propio contrato, en cada llamada
  que ya toca esas entradas — "housekeeping" gratis, sin necesidad de un job separado). Se
  documenta como riesgo conocido en `plan.md` por si el checkpoint del 23-sep se validara con el
  contrato inactivo varios días antes del cierre del 25-sep — la ventana total es corta, así que el
  margen por defecto del máximo TTL permitido cubre sobradamente el plazo completo del hackatón.

## 4. Invocación del contrato desde una Edge Function en Deno

**Decisión**: reutilizar `@stellar/stellar-sdk` (ya es dependencia del proyecto vía
`_shared/stellar-payment.ts`), que desde la v11 incluye el módulo `rpc` (cliente Soroban RPC) sin
necesitar un paquete adicional. **Actualizado a `^17`** tras la implementación: `^13` no puede
parsear `getTransaction()` contra una red en protocolo 28 (`Bad union switch: 4`), verificado en
vivo — ver `tasks.md` → "Estado real de la implementación". Nuevo helper compartido `supabase/functions/_shared/
stellar-soroban.ts`, mismo patrón de extracción que `stellar-keypair.ts`:

```
invocarContratoAdmin(secretoAdmin, contractId, metodo, args) -> Promise<{ hash, valorRetorno }>
```

Pasos internos: construir la operación con `new Contract(contractId).call(metodo, ...args)` →
envolver en `TransactionBuilder` → `server.prepareTransaction()` (simula y completa fee/footprint;
si la simulación devuelve un error de contrato — p. ej. `CapExceeded` — se lanza de inmediato sin
someter nada a la red, evitando pagar un fee por una transacción que se sabe que va a fallar) →
firmar con el `Keypair` de la autoridad → `server.sendTransaction()` (Soroban es asíncrono: esto
solo entrega la transacción a la red) → *poll* de `server.getTransaction(hash)` cada 2s hasta
`SUCCESS`/`FAILED` o un timeout interno de 15s (igual de acotado que el timeout de 25s ya usado
para Horizon en `stellar-payment.ts`, ajustado porque el ciclo de cierre de ledger en testnet es
más corto que el margen que se necesitaba para Horizon clásico). El llamador (`confirmar-aporte`,
`asignar-factura`) envuelve esta función en el bucle de reintentos descrito en §2.

Para lecturas (verificación independiente en `quickstart.md`, no usada por las Edge Functions en
producción porque Postgres ya refleja el mismo dato): `balance`/`cap`/`total_supply` se consultan
con `server.simulateTransaction()` contra cualquier cuenta de origen válida — no requieren firma ni
gastan fee, ya que nunca se someten a la red.

**Manejo de errores y reintentos**: los errores del contrato (`#[contracterror]`, ver
`data-model.md`) llegan como parte del resultado de la simulación/ejecución con un código propio
(`Error(Contract, #N)`); el helper los traduce a los códigos `PAxxx` de este proyecto antes de
devolverlos al llamador, igual que `errorDesdeSupabase()` ya traduce errores de Postgres en
`confirmar-aporte/index.ts`.

## 5. Autorización del operador en el contrato: distinción y rotación

**Decisión**: el contrato no conoce cuentas de operador individuales — conoce una única dirección
`admin` por instancia (por tramo), fijada en `initialize` a la autoridad de plataforma (§1). Las
funciones administrativas (`register_invoice`, `mint`, `set_admin`) exigen `admin.require_auth()`
(autorización nativa de Soroban: la transacción debe venir firmada por esa dirección exacta) — así
es como el contrato "hace cumplir por sí mismo" que nadie más registre facturas (FR-015 de la
spec), sin depender de que Postgres se comporte correctamente.

**Rotación/revocación**: `set_admin(new_admin: Address)` — invocable únicamente por el `admin`
actual, transfiere la autoridad a una dirección nueva. Este es el mecanismo para rotar la llave si
la copia en Vault se sospechara comprometida: se genera y fondea una autoridad nueva, se invoca
`set_admin` en cada instancia de contrato desplegada (uno por tramo — un bucle simple, no una
operación atómica global, aceptado dado el número reducido de tramos en la escala de esta demo), y
se actualiza `configuracion_red` con la nueva llave pública y el nuevo secreto en Vault. No se
implementa un mecanismo de rotación automática ni de múltiples administradores (multisig) — fuera
de alcance para el plazo del hackatón; documentado como decisión consciente, no como omisión.

## 6. Consecuencia de diseño: `capital_objetivo` de un tramo pasa de fijo a dinámico

Hallazgo al revisar el esquema ya desplegado (`0003_dominio_pools.sql`, `0008_cotizaciones_
aportes.sql`): `tramos.capital_objetivo` ya existe y ya es la base de `cotizar_aporte`/
`reservar_aporte` para calcular cupo disponible (`capital_objetivo - capital_comprometido`). La
spec de esta feature exige que las fracciones de un tramo salgan de la suma de anticipos de sus
facturas asignadas, redondeada hacia abajo a la unidad mínima (respuesta del usuario a la
clarificación de fraccionamiento). **Decisión**: en vez de introducir una segunda noción de
"capital" en paralelo (que obligaría a reescribir `cotizar_aporte`/`reservar_aporte`, ya en
producción y validados), `capital_objetivo` **se vuelve dinámico**: crece exactamente en múltiplos
de `unidad_minima_aporte` cada vez que el operador asigna una factura, y nunca decrece salvo que
una asignación se revierta antes de confirmarse on-chain (§ver `data-model.md` — ciclo de vida de
Asignación). Con esta decisión, **`cotizar_aporte`, `reservar_aporte`, `confirmar_aporte`,
`revertir_aporte`, `catalogo_pools` y `detalle_pool` no cambian su lógica de cupo en absoluto** —
siguen leyendo `capital_objetivo - capital_comprometido` exactamente igual que hoy. Solo cambia
**quién y cuándo actualiza `capital_objetivo`**: antes era un valor fijo cargado por el seed: ahora
lo actualiza `asignar_factura_a_pool` (nueva función de esta feature). Esta es la decisión que
minimiza el riesgo de regresión sobre la feature ya construida y validada.

## 7. Consecuencia de diseño: `operaciones` se renombra a `facturas`

La tabla `operaciones` (creada en `0003_dominio_pools.sql`) ya representa exactamente el concepto
de "Factura" de esta spec, pero fue diseñada asumiendo que nacía ya asignada a un pool
(`pool_id not null`) — coherente con el alcance de la feature anterior, que no incluía originación.
**Decisión**: renombrarla a `facturas` (`ALTER TABLE ... RENAME TO`, una sola sentencia, sin
pérdida de datos) dentro de una migración **nueva** de esta feature, nunca editando
`0003_dominio_pools.sql` ya aplicada (Principio VII). Los dos únicos lugares que referencian
`public.operaciones` en código ya desplegado (`catalogo_pools`, `detalle_pool`, ambas en
`0009_catalogo_consultas.sql`) se actualizan con `CREATE OR REPLACE FUNCTION` en una migración
nueva de esta feature — mismo patrón ya usado por `0004_config_edge_functions_url.sql` para
corregir una función de una migración previa sin editarla. `pool_id` pasa de `NOT NULL` a
nulificable (una factura nace sin pool hasta que el operador la asigna); el trigger de coherencia
de moneda (`operaciones_moneda_coincide_pool`) se reemplaza por uno nuevo que solo valida cuando
`pool_id is not null`.

## 8. Alcance de "asignar una factura a un pool": pool y tramo, no solo pool

La spec (FR-006) dice "asignar... a un único pool", pero FR-009/FR-010 hablan de "el tramo
correspondiente" como si ya estuviera determinado. **Decisión de diseño** (resuelve la ambigüedad
sin reabrir la spec): la asignación manual del operador especifica **pool y tramo** (`tramo_id`,
que ya implica el pool vía `tramos.pool_id`) — es decir, el operador decide con un clic adicional
si el anticipo de esa factura respalda el tramo senior o el junior de ese pool. Esto **no** es el
"reparto entre tramos" que la spec deja fuera de alcance (esa exclusión se refiere a una fórmula
automática de distribución de pérdidas/proceeds entre tramos al momento de cobro/liquidación, no a
la elección manual de qué tramo respalda cada factura en el momento de originación) — es
consistente con el tema transversal de la spec de que toda asignación es manual y explícita del
operador, nunca calculada.

## 9. Hallazgo de integración post-implementación (2026-09-22): desface entre `fracciones_totales`
   (Postgres) y `cap`/`total_supply` (contrato real) en la mayoría de los tramos ya sembrados

Validación de integración end-to-end contra el proyecto remoto real (login → catálogo → detalle →
facturas anonimizadas → saldo → cotizar/confirmar aporte → verificación directa del contrato con
`stellar contract invoke`, sin pasar por el backend de Paul). Se reprodujo dos veces un aporte real
fallando en el paso de `mint` (`PA019`, con reembolso automático correcto) sobre el tramo senior de
"Retail Norte" — el mecanismo de reversión funciona bien, pero ningún aporte nuevo puede
completarse hoy en la mayoría de los pools.

**Causa raíz confirmada** (no es un bug del contrato ni de `confirmar-aporte`, es un dato de
seed): `supabase/seed/03_originacion_facturas_demo.sql` asigna facturas a pools usando hashes de
transacción "placeholder" (`SEED_TX_HASH_101`, `SEED_TX_HASH_102`, y una asignación de prueba con
`TEST_TX_HASH_PLACEHOLDER`) — el propio archivo lo advierte en su comentario, pero el efecto no se
había verificado contra el contrato real hasta ahora: `register_invoice` nunca se ejecutó de
verdad para esas facturas, así que el `cap` on-chain de esos tramos quedó en `0` aunque Postgres
muestra `fracciones_totales` > 0.

**Estado real verificado, tramo por tramo, contra Stellar testnet** (de las 4 facturas en todo el
sistema con `huella_hash` real — el resto de facturas "asignadas" son de antes de esta feature, sin
hash, y no requieren `register_invoice`):

| Pool / tramo | Facturas reales asignadas | `cap` on-chain verificado | ¿Aporte nuevo funciona hoy? |
|---|---|---|---|
| Manufactura Sur, senior (`c...201`, contrato `CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO`) | `e...104` (anticipo 3200, `onchain_tx_hash` real) | `312` ✅ (= `fracciones_totales`), `total_supply=1` | **Sí** |
| Retail Norte, senior (`c...101`, contrato `CCAQJAZFFITJ6DJY7T6OG343OAURAWGLUQUF3ONKNBN55FMYP3EA7RRE`) | `e...101` (2000, placeholder), `a3094fa2...` (4050, placeholder) | `0` ❌ (Postgres dice 200) | No, hasta corregir |
| Retail Norte, junior (`c...102`, contrato `CAGPMH4CXI5L65VQXKPU3YQQLDEDFHOHX34CZZW2D6OS7HZ77WG5NZEN`) | `e...102` (1500, placeholder) | `0` ❌ (Postgres dice 75) | No, hasta corregir |
| Servicios Lima, Construcción Centro, Comercio y Tecnología Mixto, Tecnología Exportadora (8 tramos restantes) | Ninguna | `0` (no verificado en todos, inferido — Servicios Lima senior confirmado `0`) | No — no es un bug, nunca se les asignó una factura real todavía |

**Corrección pendiente para Retail Norte** (no ejecutada — requiere firmar con la llave de
autoridad del operador, que el entorno de esta sesión bloqueó materializar por seguridad;
pendiente de que alguien con el toolchain propio la corra):

```bash
stellar contract invoke --id CCAQJAZFFITJ6DJY7T6OG343OAURAWGLUQUF3ONKNBN55FMYP3EA7RRE \
  --source-account <ADMIN_SECRET> --network testnet -- \
  register_invoice --invoice_hash f1323e8ef73b9e6cd9995ab06d059fe1b29804d808a6b7fc3c1cf4f55b689690 --new_cap 160

stellar contract invoke --id CCAQJAZFFITJ6DJY7T6OG343OAURAWGLUQUF3ONKNBN55FMYP3EA7RRE \
  --source-account <ADMIN_SECRET> --network testnet -- \
  register_invoice --invoice_hash 2c5f384fe614e5d2e436ed5ec218ce3f557e45007edb64440bae777aa6cf4314 --new_cap 200

stellar contract invoke --id CAGPMH4CXI5L65VQXKPU3YQQLDEDFHOHX34CZZW2D6OS7HZ77WG5NZEN \
  --source-account <ADMIN_SECRET> --network testnet -- \
  register_invoice --invoice_hash 1758dda37425f92a11072e8bfac80793ebcb1fc5c13f71452b56aa73b633ea4c --new_cap 75
```

Los `new_cap` se derivaron de `fracciones_totales` actual de cada tramo (destino final) y de
`floor(anticipo acumulado / unidad_minima_aporte)` (incremento por factura), verificado contra el
mismo patrón que sí funcionó en Manufactura Sur.

**Para el resto de pools** (Servicios Lima, Construcción Centro, Comercio y Tecnología Mixto,
Tecnología Exportadora): no es un "arreglo retroactivo" posible — nunca se les asignó una factura
real por la vía nueva. Para que acepten un aporte nuevo que tokenice de verdad, hace falta
`registrar_factura` + `asignar_factura_a_pool` sobre una factura real para esos tramos primero
(mismo flujo que ya funcionó una vez en Manufactura Sur con `e...104`).

**Recomendación para la demo/checkpoint**: usar **Manufactura Sur (tramo senior)** como el pool
para cualquier demo en vivo de un aporte — es el único que hoy tokeniza de verdad sin necesitar
ninguna corrección previa.
