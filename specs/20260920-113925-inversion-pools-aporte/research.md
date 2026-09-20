# Research: Exploración de Pools y Primer Aporte del Inversionista

Investigación de los 5 puntos solicitados, más las decisiones de arquitectura que se derivan de
ellos. Todo lo verificado abajo se hizo contra la documentación oficial (WebSearch) y, donde fue
posible, contra la red de pruebas real (Friendbot/Horizon testnet) directamente desde este entorno
— no se asumió nada que se pudiera comprobar.

## 1. Límites de las funciones RPC de Supabase relevantes para transacciones y bloqueos de concurrencia

**Hallazgos**:

- Cada llamada a una función vía `/rest/v1/rpc/...` (PostgREST) se ejecuta dentro de **una sola
  transacción de base de datos** (PostgREST envuelve cada request en `BEGIN ... COMMIT`/`ROLLBACK`
  automáticamente). Esto es exactamente lo que se necesita para que "reserva (cupo + saldo)" sea
  una operación atómica de una sola sentencia de función — no hace falta ningún mecanismo
  adicional de transacción explícita.
- PostgREST se autentica ante Postgres como el rol `authenticator` y hace `SET ROLE` al rol JWT
  (`authenticated`/`anon`/`service_role`); el hallazgo más reciente en la documentación y en
  discusiones de la comunidad (verificado en 2026) es que **`ALTER ROLE authenticated SET
  statement_timeout = ...` no siempre se refleja de forma confiable**, porque el login inicial se
  hace como `authenticator` (con su propio `statement_timeout` corto, ~8s) y el `SET ROLE`
  posterior no vuelve a aplicar el `statement_timeout` del rol de destino. Lo que **sí** es
  confiable es fijar el timeout a nivel de la propia función: `CREATE FUNCTION ... SET
  statement_timeout = '5s' AS $$ ... $$`. Decisión de este plan: todas las funciones RPC de esta
  feature declaran su propio `statement_timeout` corto (5s) en la definición — igual de rápido de
  lo que en la práctica necesitan (ver abajo), y evita depender del comportamiento de `ALTER ROLE`.
- **Patrón de concurrencia elegido — `UPDATE` condicional atómico, sin locks explícitos**: para
  garantizar que el cupo de un tramo nunca se supera (FR-026, SC-002) no se usa
  `SELECT ... FOR UPDATE` seguido de una decisión en PL/pgSQL (ventana de carrera entre el
  `SELECT` y el `UPDATE` bajo `READ COMMITTED`, el nivel por defecto), sino una única sentencia:

  ```sql
  update public.tramos
  set capital_comprometido = capital_comprometido + p_monto
  where id = p_tramo_id
    and capital_comprometido + p_monto <= capital_objetivo
  returning id;
  ```

  Postgres evalúa el `WHERE` y aplica el `UPDATE` de forma atómica por fila: si 20 solicitudes
  llegan al mismo tiempo sobre la misma fila de `tramos`, Postgres las serializa automáticamente a
  nivel de fila (cada `UPDATE` espera brevemente el lock de fila de la anterior, nunca corrompe el
  valor), y cada una vuelve a evaluar `capital_comprometido + p_monto <= capital_objetivo` con el
  valor ya actualizado por la anterior — la primera que ya no cabe simplemente no actualiza
  ninguna fila (`0 rows`), y la función lo detecta (`if not found then raise ...`). No se necesita
  `pg_advisory_lock` ni `SELECT ... FOR UPDATE` para este invariante.
- **Concurrencia del tope diario de recarga (SC-008)**: a diferencia del cupo de un tramo (una
  fila compartida por todos), el tope diario es por-inversionista — cada inversionista solo
  compite consigo mismo. Se usa `pg_advisory_xact_lock(hashtextextended(p_investor_id::text ||
  ':' || (now() at time zone 'America/Lima')::date::text, 0))` al inicio de
  `recargar_saldo_demo()`: serializa únicamente las recargas del mismo inversionista en el mismo
  día (Lima), sin bloquear a otros inversionistas entre sí. El lock se libera solo al terminar la
  transacción (`_xact_lock`), consistente con que toda la función corre en una sola transacción.
- **Conclusión**: ninguna función de esta feature necesita más de unos pocos milisegundos de
  trabajo real (un `UPDATE` de una fila, una suma, un `INSERT`); el timeout de 5s por función deja
  margen amplio incluso bajo contención de 20 solicitudes simultáneas sobre el mismo tramo.

## 2. ¿El Database Webhook de aprovisionamiento de wallet está versionado y funciona en local?

**Está versionado** (cumple Principio VII): `trigger_provision_wallet()` y su trigger
`perfiles_provision_wallet` viven en `supabase/migrations/0002_wallet_provisioning.sql`, no se
crearon desde el Dashboard.

**NO funciona en local tal como está — hallazgo verificado en el código, no solo documentación**:
la función tiene hardcodeada la URL de producción:

```sql
v_function_url text := 'https://qqpozotcrxfukkwcoget.supabase.co/functions/v1/provision-investor-wallet';
```

Según la documentación de Supabase sobre desarrollo local con Database Webhooks: Postgres corre
dentro de un contenedor Docker, así que `localhost`/`127.0.0.1` en una URL de webhook apunta al
propio contenedor, no al host — hace falta `http://host.docker.internal:<puerto-api-local>/functions/v1/<función>`
para llegar al runtime de Edge Functions local (que `supabase start` ya levanta automáticamente,
confirmado por la sección `[edge_runtime]` ya presente en `config.toml`). Con la URL actual
hardcodeada a producción, **cualquier registro de inversionista hecho contra el stack local
dispararía el aprovisionamiento de wallet contra la Edge Function de PRODUCCIÓN**, no la local —
además de que la función no puede reaccionar a cambios de entorno sin editar código.

**Decisión (corrige el hallazgo)**: introducir un mecanismo de URL base configurable por entorno,
sin hardcodear ningún literal de entorno en el cuerpo de la función:

- Una función interna `public.obtener_url_base_functions()` (mismo patrón que
  `obtener_shared_secret_webhook()`, `security definer`, `execute` revocado a
  `public/anon/authenticated`) que lee el valor desde un secreto de Vault
  (`edge_functions_base_url`).
- En local, el seed (`supabase/seed/00_auth_demo_local.sql`, ver más abajo) crea ese secreto con
  el valor `http://host.docker.internal:54321/functions/v1` (puerto de `[api] port` en
  `config.toml`).
- En remoto, el mismo secreto ya apunta (o se crea apuntando) a
  `https://qqpozotcrxfukkwcoget.supabase.co/functions/v1` — el mismo valor que hoy está
  hardcodeado, así que el comportamiento en producción no cambia.
- Migración correctiva: `CREATE OR REPLACE FUNCTION public.trigger_provision_wallet()` en una
  nueva migración de esta feature, sustituyendo el literal por
  `obtener_url_base_functions() || '/provision-investor-wallet'`. Es seguro re-desplegar un
  `CREATE OR REPLACE FUNCTION` sobre un proyecto remoto ya en marcha (no borra datos, no toca
  `perfiles` ni las wallets ya aprovisionadas) — solo cambia el cuerpo de la función a partir de
  ese momento.
- El nuevo trigger de aprovisionamiento de custodia de pool (ver `data-model.md`) se construye
  **desde el principio** con este mecanismo, para no repetir el mismo hallazgo.

**Verificado en vivo durante la implementación (T036)**, contra el stack local real
(`supabase start` + `db reset`), con dos hallazgos adicionales encontrados y corregidos en el
camino, ninguno documentable solo por lectura de documentación:

1. **`webhook_shared_secret` tampoco existía en local**: se había creado manualmente solo contra
   el proyecto remoto durante la feature previa (nunca versionado). Corregido en
   `0004_config_edge_functions_url.sql`: se genera automáticamente (`vault.create_secret` con un
   valor aleatorio) si no existe, sin tocar el valor ya existente en remoto (`if not exists`).
2. **El Kong local exige un header `Authorization`/`apikey` para enrutar a `/functions/v1/*`,
   incluso hacia una función con `verify_jwt=false`** — ese flag solo controla si la propia Edge
   Function exige JWT, no si Kong deja pasar la solicitud. Confirmado experimentalmente:
   `net.http_post` sin ese header devolvía `401 UNAUTHORIZED_NO_AUTH_HEADER` (o, en un estado
   transitorio del edge-runtime todavía cargando la función, `404 Function not found`); con el
   header, la función se ejecutó y devolvió `200` con la wallet/custodia real. **En producción
   esto no hace falta** — ya verificado en la feature previa (T018 de
   `specs/20260919-131233-auth-perfil-usuario`, sin este header). Corrección: un tercer secreto
   opcional, `edge_functions_gateway_apikey`, creado solo en local con el anon key público fijo de
   cualquier stack local de Supabase (no un secreto real); si el secreto no existe (remoto), los
   triggers omiten el header por completo, igual que el comportamiento ya verificado en
   producción — cero riesgo de romper lo que ya funciona ahí.

Con las tres correcciones, `supabase db reset` en local aprovisiona correctamente las 3 wallets de
inversionista y las 6 cuentas de custodia de pool con direcciones reales de Stellar testnet, sin
ninguna llamada accidental a producción.

## 6. Hallazgo de la prueba de 20 aportes simultáneos (T036, SC-002/SC-003)

**Verificado en vivo** contra un tramo efímero con cupo exacto para 10 aportes de 100 (objetivo
1000, unidad 100), disparando 20 confirmaciones realmente simultáneas (`Promise.all`) repartidas
entre las 3 cuentas demo de inversionista: **el cupo nunca se superó** —
`capital_comprometido` terminó en 800 (≤ 1000) y coincidió exactamente con la suma de aportes
`confirmado` (SC-003) — pero solo 8 de las 20 terminaron `confirmado`, no los 10 que el cupo
permitía: 10 se rechazaron correctamente en la reserva (`PA003`, esperado) y **2 fallaron en el
paso de pago con `PA013`** por colisión real del *sequence number* de Stellar — cuando la misma
billetera de un inversionista somete más de un `Payment` concurrentemente, dos solicitudes pueden
leer el mismo `sequence` de la cuenta (vía `loadAccount`) antes de que la primera se confirme, y
Horizon rechaza la segunda (`tx_bad_seq`). El sistema revirtió esos 2 casos limpiamente
(`revertir_aporte`, `motivo_reversion='fallo_red_stellar'`), liberando su cupo y su saldo de
demostración sin dejar ningún estado colgado — el invariante que exige la spec (nunca superar el
cupo, nunca perder saldo) se cumple igual.

**No corregido en este plan** (aceptado como limitación conocida, Principio I — velocidad sobre
perfección): un reintento automático ante `tx_bad_seq` en `_shared/stellar-payment.ts` eliminaría
este falso-negativo cuando **el mismo inversionista** dispara varios aportes a la vez — no afecta
al invariante de cupo (que ya se sostiene), solo a cuántos de los intentos legítimos se confirman
en el primer intento. Con más cuentas de inversionista distintas (como ocurriría con usuarios
reales concurrentes, cada uno con su propia billetera) esta colisión no ocurre, porque cada
billetera tiene su propia secuencia independiente.

## 3. Tiempos máximos de una Edge Function frente a la confirmación de Stellar testnet

**Límites confirmados (documentación oficial de Supabase, 2026)**:
- **Wall-clock**: 150s en el plan gratuito, 400s en planes pagos — duración total de la función,
  incluyendo tiempo de espera de I/O (red).
- **CPU activa**: 2s de cómputo por request — no incluye el tiempo de espera de una llamada de red
  (a Horizon, a Friendbot, a Vault vía RPC); solo cómputo real (construir/firmar la transacción,
  generar el keypair). Irrelevante como límite práctico aquí: firmar una transacción Stellar toma
  milisegundos.
- **Idle timeout de request**: 150s — si la función no responde antes, el cliente recibe `504`.

**Frente al tiempo de confirmación de Stellar testnet**: el intervalo de cierre de ledger en
testnet es de ~5 segundos; una transacción bien formada normalmente se confirma (o se rechaza) en
uno o dos cierres de ledger tras el `submitTransaction`, es decir, **algunos segundos, no
minutos**, en el caso normal. Confirmado indirectamente por la prueba en vivo de la sección 5: la
llamada a Friendbot (que en sí misma somete una transacción de fondeo) devolvió `hash`/
`successful: true` en la misma respuesta HTTP síncrona, sin necesidad de sondeo adicional.

**Decisión**: la orquestación síncrona completa de `confirmar-aporte`
(reservar en DB → construir y someter el pago XLM → esperar la confirmación → confirmar/revertir
en DB) encaja holgadamente dentro del límite de 150s incluso en el plan gratuito. Aun así, para
evitar que una degradación puntual de Horizon deje la función colgada cerca del límite de 150s
(lo que el cliente vería como un `504` sin respuesta clara — inaceptable frente a FR-034,
"resultado inmediato... sin dejarlo pendiente"), la función fija su propio timeout interno de
**25 segundos** para la llamada de sometimiento/confirmación a Horizon (`fetch` con `AbortSignal.timeout(25_000)`
o el timeout nativo del SDK): si Horizon no responde en ese margen, la función revierte la reserva
y devuelve un fallo explícito (`PA013: fallo_red_stellar`) en vez de esperar hasta el límite de la
plataforma. 25s deja margen amplio (varios cierres de ledger) sin acercarse al límite de 150s.

## 4. Diseño de la cuenta de custodia del pool

**Opciones evaluadas**:

| | Una única cuenta + memo por pool | Una cuenta dedicada por pool |
|---|---|---|
| Piezas nuevas a construir | Una función para interpretar memos al reconciliar | Cero — reutiliza exactamente el mismo patrón ya construido para wallets de inversionista (`Keypair.random()` + Friendbot + Vault) |
| Auditar cuánto custodia un pool en la red | Requiere sumar pagos filtrados por memo — el balance de la cuenta no es directamente el capital del pool | El balance on-chain de la cuenta **es** directamente el capital custodiado del pool, verificable en Horizon sin lógica adicional |
| Límite técnico | `MEMO_TEXT` tiene 28 bytes — no cabe un UUID completo, obliga a mantener un código corto por pool solo para este propósito | Ninguno |
| Migración futura a contrato Soroban por pool | Cambia de "una cuenta + interpretar memo" a "una dirección de contrato" — cambio de forma de dato, no solo de valor | Cambia solo el **valor** de `pools.custody_public_key` (de address de cuenta a address de contrato) — la forma del dato y el contrato de API no cambian, tal como pide la spec |
| Costo | Una reserva base de Stellar (1 XLM) por pool — trivial para ~5-8 pools de demo | Igual |

**Decisión**: **una cuenta de custodia dedicada por pool**, generada con el mismo mecanismo ya
existente (Keypair + Friendbot + Vault), vía un Database Webhook análogo al de wallets de
inversionista (`aprovisionar_custodia_pool`, disparado por `INSERT` en `pools` con
`custody_secret_id IS NULL`). Ver `data-model.md` §Pool. Esto satisface directamente el requisito
"la custodia on-chain debe poder cambiar de destino cuando exista el contrato Soroban sin cambiar
el contrato de API": el resto del sistema (`cotizar_aporte`, la Edge Function `confirmar-aporte`)
solo lee `pools.custody_public_key` como destino del pago, sin saber ni importarle si es una
cuenta clásica o, en el futuro, la dirección de un contrato.

**Alternativa descartada**: cuenta única + memo — introduce una pieza de reconciliación nueva
(parsing de memos) sin ahorrar nada real frente a reutilizar el patrón ya construido, y complica
la migración futura a Soroban exactamente en el punto que la spec pide mantener estable.

## 5. ¿Friendbot recarga cuentas ya existentes? (justifica la recarga off-chain)

**Prueba ejecutada en vivo contra testnet real** (no simulada), desde este entorno:

1. Se generó un keypair ed25519 válido (StrKey, sin dependencias externas) y se fondeó por
   primera vez: `GET https://friendbot.stellar.org?addr=G...` → `200 OK`,
   `"successful": true`. Verificado contra Horizon: `balances[0].balance = "10000.0000000"`.
2. Se repitió exactamente la misma llamada de Friendbot sobre la **misma** cuenta ya fondeada:

   ```json
   HTTP 400
   {
     "type": "https://stellar.org/friendbot-errors/bad_request",
     "title": "Bad Request",
     "status": 400,
     "detail": "account already funded to starting balance"
   }
   ```

   Verificado de nuevo contra Horizon: el balance **no cambió**, sigue en `10000.0000000`.

**Conclusión confirmada empíricamente**: Friendbot fondea una cuenta **una sola vez** (al
crearla); un segundo intento sobre una cuenta ya existente es rechazado sin acreditar nada. Esto
confirma que el diseño de la spec es correcto y necesario: como las billeteras de los
inversionistas ya se crean fondeadas una única vez al registrarse (feature previa), **no existe
ningún mecanismo on-chain para que un inversionista obtenga más XLM de prueba después** — de ahí
que la "recarga de saldo de demostración" (FR-001 a FR-008 de la spec) deba ser necesariamente un
crédito off-chain (contable, en soles/dólares) y no un intento de volver a pedirle XLM a
Friendbot, que fallaría siempre a partir del segundo intento.

## 7. Hallazgos del despliegue a producción (T042/T043)

**Desfase del historial de migraciones remoto**: el proyecto vinculado ya tenía aplicado el
esquema equivalente a `0001_perfiles.sql`/`0002_wallet_provisioning.sql` (verificado con `select
table_name from information_schema.tables` antes de tocar nada — la tabla `perfiles` ya existía),
pero su tabla de historial (`supabase_migrations.schema_migrations`) registraba esos cambios bajo
10 versiones con timestamp de cuando esas migraciones existían como archivos separados, antes de
consolidarse localmente en `0001`/`0002`. Un `db push` directo habría intentado recrear `perfiles`
y fallado. Se corrigió con `supabase migration repair` (operación de metadata pura, no toca
esquema): `0001`/`0002` marcadas `applied`, las 10 versiones huérfanas marcadas `reverted`. Lección
para futuras features: si se consolidan/renombran migraciones ya aplicadas en remoto, reparar su
historial antes del siguiente `db push`, no asumir que los nombres de archivo coinciden con las
versiones registradas.

**Bug real encontrado antes de aplicar `0004_config_edge_functions_url.sql` a remoto**: el bloque
que crea el secreto `edge_functions_gateway_apikey` (la apikey que el Kong LOCAL exige, ver
hallazgo 2 de la sección 2) lo creaba de forma incondicional si faltaba, sin distinguir entorno —
el comentario decía "nunca se crea en remoto" pero el código no lo verificaba. Si se hubiera
aplicado tal cual, el proyecto remoto habría terminado con este secreto (el anon key público y
bien conocido de cualquier stack local) guardado como si fuera la apikey real de producción,
enviándose de ahí en adelante como header a Kong remoto en cada webhook. Se corrigió **antes** de
aplicar la migración a remoto (nunca se había aplicado, así que no hizo falta una migración de
parche) agregando una detección de entorno real: `current_setting('app.settings.jwt_secret',
true)` es el valor por defecto del template (`super-secret-jwt-token-with-at-least-32-characters-long`)
en cualquier stack local de Supabase, y `NULL` en el proyecto remoto — verificado en vivo contra
ambos entornos antes de confiar en la comprobación. Tras el fix, `db reset` local se volvió a
correr completo (limpio, sin errores) para confirmar que el secreto se sigue creando en local, y el
`db push` a remoto confirmó que no se crea ahí.

**Cold-start transitorio en el trigger de custodia de pool**: al aplicar `01_dominio_demo.sql`
contra remoto (6 `INSERT` en `pools`, cada uno disparando el webhook de aprovisionamiento de
custodia), 5 de 6 llamadas a la Edge Function recién desplegada tuvieron éxito y 1 devolvió `401
no_autorizado` — diagnosticado revisando `net._http_response`. La causa no fue el secreto en sí
(las otras 5 lo validaron correctamente con el mismo valor) sino que la función `autenticado()`
trata cualquier error de la RPC `obtener_shared_secret_webhook()` como "no autorizado" antes de
comparar el secreto, y la primera invocación después de un deploy puede sufrir un blip transitorio
de conexión. Se resolvió reintentando manualmente esa única llamada (mismo payload que envía el
trigger, mismo secreto, vía `curl` directo a la función desplegada), que devolvió éxito de
inmediato en el segundo intento. No se consideró necesario agregar reintentos automáticos al
trigger para un caso tan infrecuente (Principio I).

## Resumen de decisiones

| Punto investigado | Decisión |
|---|---|
| Atomicidad del cupo | `UPDATE` condicional de una sola sentencia sobre `tramos`, sin locks explícitos |
| Timeout de funciones RPC | `statement_timeout` fijado por función (5s), no por rol |
| Tope diario de recarga concurrente | `pg_advisory_xact_lock` por `(inversionista, día Lima)` |
| Webhook de wallet en local | Roto (URL de prod hardcodeada) — se corrige con una función `obtener_url_base_functions()` respaldada por un secreto de Vault por entorno |
| Timeout de Horizon dentro de la Edge Function | 25s internos, muy por debajo del límite de plataforma de 150s |
| Custodia del pool | Una cuenta dedicada por pool (mismo patrón que wallets de inversionista), nunca una cuenta compartida con memo |
| Recarga de saldo demo | Confirmado empíricamente que debe ser off-chain: Friendbot rechaza cuentas ya fondeadas |
