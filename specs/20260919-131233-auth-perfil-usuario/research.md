# Research: Registro, Inicio de Sesión y Perfil de Usuario

Todas las decisiones de esta feature estaban predefinidas por el contexto del plan o resueltas
por investigación directa contra la documentación oficial de Stellar y Supabase (vía MCP). No
quedan `NEEDS CLARIFICATION` en el Technical Context.

## 1. Custodia y almacenamiento seguro de la llave privada de la wallet

**Decision**: Usar **Supabase Vault** (`vault.create_secret()` / vista `vault.decrypted_secrets`)
para almacenar la llave privada (secret key) de cada wallet de inversionista. La tabla
`public.perfiles` solo guarda `wallet_secret_id` (referencia UUID al secreto en Vault) y
`wallet_public_key` (dirección pública, dato no sensible). Ningún rol de la API pública
(`anon`/`authenticated`) recibe privilegios sobre el esquema `vault`; solo el `service_role`
(usado exclusivamente por la Edge Function de backend) puede leer el secreto descifrado.

**Rationale**: Vault es una extensión nativa de Supabase (Postgres + `pg_net`/`libsodium` por
debajo) pensada exactamente para este caso — secretos cifrados en reposo con la clave de cifrado
gestionada fuera de la base de datos por Supabase, nunca junto a los datos cifrados. Comparado con
cifrar manualmente una columna con una clave puesta en una variable de entorno de la Edge
Function: Vault evita que el equipo tenga que implementar y auditar su propia lógica de
cifrado/descifrado en una semana, y evita el riesgo de dejar la clave de cifrado en el mismo lugar
que el dato cifrado. Es la opción con menor esfuerzo de implementación que aun así nunca deja la
llave privada en texto plano — alineado con el Principio I (velocidad) sin violar el requisito no
negociable de custodia segura.

**Alternatives considered**:
- **Cifrado manual con `pgcrypto` + clave en variable de entorno de la Edge Function**: viable,
  pero obliga al equipo a implementar correctamente el cifrado/descifrado, la rotación de clave y
  el manejo de nonces — trabajo y superficie de error adicional para una demo de una semana, sin
  ganar seguridad real frente a Vault.
- **`pgsodium` con Transparent Column Encryption**: la propia documentación de Supabase indica que
  está en camino de deprecación y **no recomienda su uso para proyectos nuevos** — descartado.
  Vault seguirá funcionando igual aunque `pgsodium` cambie por debajo.
- **No-custodial (llave entregada al usuario)**: descartado explícitamente en la clarificación de
  la spec (`/speckit-clarify`) por el riesgo de bloqueo irreversible en una demo en vivo.

## 2. Generación y fondeo del par de llaves de Stellar testnet

**Decision**: En la Edge Function `provision-investor-wallet` (Deno), usar
`@stellar/stellar-sdk` (import `npm:@stellar/stellar-sdk`) para:
1. Generar el keypair con `Keypair.random()`.
2. Fondear la cuenta en testnet llamando al endpoint de Friendbot
   (`https://friendbot.stellar.org?addr=<publicKey>`), confirmado por la documentación oficial y
   por el ejemplo de referencia `stellar/basic-payment-app`
   (`server.friendbot(publicKey).call()` usando el `Horizon.Server` del SDK apuntando a
   `https://horizon-testnet.stellar.org`).
3. Guardar `keypair.publicKey()` en `perfiles.wallet_public_key` y `keypair.secret()` como
   secreto en Vault, referenciado por `perfiles.wallet_secret_id`.

**Rationale**: Es el patrón documentado oficialmente por Stellar para testnet (Friendbot existe
solo en testnet/futurenet, exactamente el caso de este proyecto) y es el mismo enfoque que usará
el resto de la plataforma para firmar transacciones reales más adelante (compra de fracciones),
así que no se introduce una segunda librería o abstracción solo para el registro.

**Alternatives considered**:
- **Generar el keypair en el cliente (móvil) y enviar la llave pública al backend**: no aplica,
  porque la decisión de custodia (Principio VI + clarificación) exige que la plataforma genere y
  guarde la llave privada desde el origen — el cliente nunca debe verla ni de forma transitoria.
- **Fondear manualmente vía Stellar Lab antes de la demo**: no escala a registro abierto (US1) ni
  a cuentas de demostración regeneradas; solo serviría como fallback manual si Friendbot falla el
  día de la demo.

## 3. Mecanismo de aprovisionamiento post-registro (dónde se genera la wallet)

**Decision**: Dos pasos encadenados, ambos patrones estándar de Supabase verificados en su
documentación:
1. Un **trigger de Postgres** (`after insert on auth.users`) ejecuta una función
   `public.handle_new_user()` (`SECURITY DEFINER`) que inserta la fila en `public.perfiles` de
   forma síncrona, usando el rol y los datos ya presentes en `raw_user_meta_data` (el registro es
   exclusivamente por email/contraseña — sin login social, el rol siempre viaja explícito en el
   mismo `signUp()`, ver §4). `wallet_public_key`/`wallet_secret_id` quedan en `null` hasta el
   aprovisionamiento.
2. Un **Database Webhook** (`after insert on public.perfiles`, filtrado a
   `rol = 'inversionista' AND wallet_secret_id IS NULL`) invoca de forma asíncrona la Edge
   Function `provision-investor-wallet`, que genera y funda el keypair (§2) y hace `UPDATE` sobre
   esa misma fila con `wallet_public_key` y `wallet_secret_id`.

**Rationale**: Un trigger de Postgres no puede hacer llamadas de red externas (a Friendbot) de
forma segura ni con reintentos — por eso el aprovisionamiento de wallet no puede vivir enteramente
en un trigger síncrono. Separar "crear el perfil" (síncrono, rápido, nunca falla por causas
externas) de "aprovisionar la wallet" (asíncrono, puede reintentarse si Friendbot falla —
consistente con el Edge Case ya documentado en la spec) evita que una falla transitoria de red
bloquee el registro completo. Database Webhooks son la forma documentada por Supabase de invocar
una Edge Function en reacción a un cambio de tabla, sin código custom de polling.

**Nota de cumplimiento (Principio VII de la constitución)**: la documentación de Supabase permite
crear un Database Webhook de dos formas — desde el Dashboard, o como una sentencia SQL directa.
Este plan usa **exclusivamente la segunda vía**: una función `SECURITY DEFINER` propia
(`trigger_provision_wallet()`, que llama a `net.http_post()` directamente en vez del wrapper
`supabase_functions.http_request()`, para poder construir el header de autenticación de forma
dinámica en cada invocación — ver §5) más su trigger, ambos definidos en
`supabase/migrations/0002_wallet_provisioning.sql` junto con `handle_new_user()` y
`perfiles_rol_inmutable()`. El Dashboard de Supabase no se usa en ningún punto de este plan para
crear o modificar este objeto — solo estaría permitido para inspeccionar su estado ya aplicado
(Principio VII).

**Alternatives considered**:
- **Generar y fondear la wallet directamente en el cliente móvil tras el `signUp()`**: descartado
  por la decisión de custodia (§1) — la generación debe ocurrir donde se guarda la llave, en el
  backend, nunca en el dispositivo del usuario.
  **Todo en un solo Edge Function invocado explícitamente por el cliente tras el `signUp()`**
  (sin trigger): más simple de trazar, pero delega al cliente la responsabilidad de "avisar" al
  backend que debe aprovisionar la wallet — si la app se cierra entre el `signUp()` y esa llamada,
  la cuenta queda sin wallet sin que el backend lo sepa. El trigger + webhook garantiza que el
  aprovisionamiento se dispara siempre que se crea un `auth.users`, sin depender del cliente.

## 4. Cómo se fija el rol de la cuenta (inversionista vs. operador de banco)

**Decision**: El `rol` (y `nombre_completo`/`telefono`) viajan explícitos como `options.data` en
`supabase.auth.signUp()`, quedando disponibles en `raw_user_meta_data` para el trigger
`handle_new_user()`, que los aplica atómicamente al crear el perfil (FR-002 cumplido en el mismo
request de registro). La columna `perfiles.rol` es `NOT NULL` — no existe ningún estado
transitorio de "cuenta sin rol": toda cuenta nace con su rol ya fijado, e inmutable desde ese
mismo instante (trigger `perfiles_rol_inmutable`, FR-003).

**Rationale**: Con un único método de registro (email/contraseña, decisión explícita del equipo
de no incorporar login social — ver más abajo), fijar el rol es trivial: siempre viaja en el
mismo request que crea la cuenta, sin necesidad de un paso posterior ni de una función para
"completar" el registro.

**Alternatives considered**:
- **Login social (Google u otro proveedor OAuth)**: evaluado y descartado explícitamente por el
  equipo. Un proveedor OAuth no permite inyectar metadata custom (como el rol elegido) de forma
  confiable en el mismo paso que crea el usuario — hubiera obligado a mantener un estado
  transitorio `rol = NULL` y una función RPC adicional (`completar_registro_oauth`) solo para ese
  caso, más complejidad de la que el equipo decidió que valía la pena para esta semana (Principio
  I). Si el equipo decide agregar login social más adelante, ese mecanismo tendría que
  reintroducirse — no se elimina por limitación técnica, sino por alcance.
- **Asumir un rol por defecto sin pedirlo explícitamente**: violaría FR-002 (rol debe ser
  explícito) y crearía cuentas con un rol adivinado en vez de elegido.
- **Determinar el rol implícitamente según qué aplicación cliente llama a la API** (por ejemplo,
  "la app móvil siempre registra inversionistas"): esto acoplaría el backend a una decisión de
  frontend que aún no existe como feature — el rol quedaría definido por convención externa, no
  garantizado por el propio backend. Se descarta para que la garantía de FR-002/FR-003 no dependa
  de que un cliente futuro "se porte bien".

## 5. Protección de datos no editables y del secreto de la wallet (RLS + privilegios)

**Decision**:
- RLS en `public.perfiles`: `SELECT`/`UPDATE` solo donde `auth.uid() = id`. Sin política de
  `INSERT` para `anon`/`authenticated` — solo la función `SECURITY DEFINER` del trigger inserta
  filas.
- Privilegios de columna: `REVOKE SELECT, UPDATE ON public.perfiles FROM authenticated;` seguido
  de `GRANT SELECT (...todas las columnas excepto wallet_secret_id...) TO authenticated;` y
  `GRANT UPDATE (nombre_completo, telefono, foto_url) TO authenticated;` — un **allow-list**, no
  un revoke de columna aislado. Solo `nombre_completo`, `telefono` y `foto_url` quedan editables
  por el usuario dueño de la fila, y `wallet_secret_id` queda fuera del `SELECT` permitido.
  `rol` no está en ningún allow-list de `UPDATE`: como se fija una sola vez en el propio
  `signUp()` (§4) y es `NOT NULL` desde la creación, no existe ninguna vía —ni siquiera una
  función `SECURITY DEFINER`— para cambiarlo después de creada la cuenta.
  **Corrección importante (detectada en T018, validación contra el proyecto real)**: la primera
  versión de este diseño usaba solo `REVOKE UPDATE (col) ... FROM authenticated` /
  `REVOKE SELECT (wallet_secret_id) ... FROM authenticated`, sin revocar antes el privilegio de
  tabla completo. Eso **no funcionó**: Supabase concede por defecto `SELECT`/`UPDATE` de tabla
  completa a `authenticated` en toda tabla nueva de `public`, y en Postgres un privilegio de
  columna revocado no anula un privilegio de tabla que sigue vigente — el rol conserva acceso si
  cualquiera de los dos lo permite. Se verificó en vivo que, con el diseño original, cualquier
  usuario autenticado podía sobrescribir su propio `wallet_public_key` y leer `wallet_secret_id`
  directamente. El patrón correcto — y el que quedó aplicado — es revocar el privilegio de tabla
  por completo y conceder explícitamente solo las columnas permitidas.
- El email vive en `auth.users` (gestionada por Supabase Auth), nunca se duplica editable en
  `perfiles`, así que no hay ninguna vía de la API pública para cambiarlo desde este flujo.
- `vault.secrets` / `vault.decrypted_secrets`: sin `GRANT` a `anon`/`authenticated` (comportamiento
  por defecto de Supabase); solo el `service_role` que usa la Edge Function puede leerlos.
- **Segundo hallazgo crítico (T027, Security Advisors)**: `CREATE FUNCTION` concede `EXECUTE` a
  `PUBLIC` por defecto, y este proyecto además concede privilegios explícitos a
  `anon`/`authenticated` en funciones nuevas — revocar solo de `PUBLIC` no bastaba.
  `aprovisionar_wallet_inversionista` y `obtener_shared_secret_webhook` quedaron, en un primer
  despliegue, invocables vía `/rest/v1/rpc/...` por cualquier usuario autenticado: se verificó en
  vivo que esto permitía inyectar una wallet falsa en el perfil de otro inversionista (mientras
  su `wallet_secret_id` siguiera `NULL`) y leer el secreto compartido del webhook. Corregido
  revocando `EXECUTE` explícitamente de `public, anon, authenticated` en todas las funciones
  `SECURITY DEFINER` de este módulo — ninguna de ellas es invocable vía RPC por `anon` ni
  `authenticated`; todas son o bien funciones de trigger (invocadas automáticamente por Postgres,
  no vía API) o solo ejecutables por `service_role` desde la Edge Function.

**Rationale**: Esto satisface FR-011 (email/rol no editables) y FR-014 (llave privada nunca
expuesta) con mecanismos nativos de Postgres/Supabase (RLS + `REVOKE`/`GRANT`) en vez de lógica de
validación a medida en cada endpoint — menos código, menos superficie de error, y es exactamente
el patrón recomendado por la documentación de Supabase para este tipo de restricción.

**Alternatives considered**:
- **Exponer una columna cifrada de la llave privada directamente en `perfiles` y protegerla solo
  con una función RPC restringida** (la opción sugerida como base en el contexto del plan): se
  descartó en favor de Vault (§1) porque Vault ya resuelve el mismo problema sin necesitar mantener
  esa columna cifrada ni la función RPC a medida — menos piezas que construir y con la misma (o
  mejor) garantía de que el secreto nunca sale vía PostgREST.

## Resumen de decisiones y trade-offs (custodia de wallet)

| Aspecto | Decisión | Trade-off aceptado |
|---|---|---|
| Dónde vive la llave privada | `vault.secrets` (Supabase Vault), referenciada por `wallet_secret_id` en `perfiles` | Depende de la gestión de clave raíz de Supabase (fuera de nuestro control directo), aceptable para una demo en testnet |
| Quién puede descifrarla | Solo `service_role` desde la Edge Function | El equipo no puede inspeccionar la llave desde el dashboard de datos sin usar la vista `vault.decrypted_secrets` explícitamente como `postgres` |
| Cuándo se genera | Asíncrono, tras el registro, vía Database Webhook + Edge Function | Ventana breve donde el perfil existe sin wallet (mitigada con reintento, ver Edge Cases de la spec) |
| Alternativa no elegida | Cifrado manual con clave en variable de entorno | Más control, pero más riesgo de error de implementación en una semana — rechazada |
