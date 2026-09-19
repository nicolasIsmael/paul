# Quickstart: Validar Registro, Login y Perfil (backend, sin UI)

Guía manual de validación (sin tests automatizados, Principio I de la constitución). Confirma que
las 4 historias de usuario funcionan de punta a punta **contra la API de un proyecto Supabase
real**, usando llamadas directas (script Node/Deno con `@supabase/supabase-js`, o `curl` +
SQL Editor) — sin ejecutar ninguna app móvil ni panel web, porque este plan no las construye.
Único método de registro/login: **email y contraseña** (sin login social).

## Prerrequisitos

- Proyecto Supabase creado, con las migraciones de `supabase/migrations/` aplicadas
  (`supabase db push` o vía el MCP de Supabase).
- `supabase/seed.sql` ejecutado (crea las cuentas de demostración de la Historia 4).
- Un script de prueba local (`scripts/probar-auth.ts` o similar, fuera del alcance de este plan
  como artefacto permanente — es solo una herramienta de validación) que inicialice el cliente:
  ```ts
  import { createClient } from "@supabase/supabase-js";
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  ```

## 1. Registro de inversionista y operador (Historia 1, email/contraseña)

```ts
const { data, error } = await supabase.auth.signUp({
  email: "inversionista.prueba@<dominio-real-que-controles>", // ver nota abajo
  password: "una-contraseña-de-prueba",
  options: { data: { rol: "inversionista", nombre_completo: "Prueba QA", telefono: "999999999" } },
});
```

> **Nota sobre el email (verificado contra el proyecto real)**: Supabase Auth rechaza dominios de
> ejemplo/placeholder (`example.com`, `.test`, etc.) con `email_address_invalid`, y el envío de
> emails de confirmación tiene un límite de tasa bajo en el plan gratuito
> (`over_email_send_rate_limit`). Para probar este paso usa una dirección real que controles, o
> desactiva temporalmente "Confirm email" en Supabase Auth para esta semana de desarrollo — el
> trigger `handle_new_user()` crea el perfil (y dispara el aprovisionamiento de wallet) en el
> `INSERT` de `auth.users`, **antes** de que se confirme el email, así que la confirmación no
> bloquea esta validación.

1. **Esperado**: `error` es `null`; `data.user.id` presente.
2. Consultar el perfil recién creado (con la sesión autenticada del propio `data.session`):
   ```ts
   const { data: perfil } = await supabase
     .from("perfiles")
     .select("rol, nombre_completo, telefono, foto_url, wallet_public_key, es_cuenta_demo") // nunca "*": wallet_secret_id no está en el allow-list de SELECT
     .eq("id", data.user.id)
     .single();
   ```
   **Esperado inmediato**: `perfil.rol === "inversionista"`, `perfil.wallet_public_key === null`
   (aprovisionamiento aún en curso).
3. Repetir la consulta unos segundos después. **Esperado**: `perfil.wallet_public_key` es una
   dirección `G...` de Stellar testnet, no `null`.
4. Verificar en el dashboard de Supabase (tabla `perfiles`) que `wallet_secret_id` apunta a un
   registro en `vault.secrets` — confirma el contrato de
   `contracts/provision-investor-wallet-function.md`.
5. Verificar en Stellar Lab / Horizon testnet (usando la dirección pública) que la cuenta existe y
   tiene balance de XLM de Friendbot — confirma evidencia on-chain real (Principio VI).
6. Repetir el `signUp()` con `rol: "operador_banco"` y otro email. **Esperado**: la cuenta queda
   creada con `rol === "operador_banco"` y `wallet_public_key` permanece `null` (los operadores
   nunca tienen wallet).

## 2. Intento de registro duplicado (Edge Case, FR-013)

1. Repetir el `signUp()` del paso 1 con el mismo email.
2. **Esperado**: `error` no es `null` e indica que el email ya está en uso; ninguna fila nueva en
   `perfiles`. (Nota: si "Confirm email" está activo, Supabase puede responder `200` con un
   usuario "fantasma" en vez de un error explícito, como protección anti-enumeración — verificar
   en ese caso que no se creó una fila nueva en `auth.users`/`perfiles`, que es la garantía real
   que exige FR-013, no el código de estado HTTP en sí.)

## 3. Login con rol expuesto (Historia 2)

1. `supabase.auth.signOut()` seguido de
   `supabase.auth.signInWithPassword({ email: "<email del inversionista del paso 1>", password: "..." })`.
2. **Esperado**: `error` es `null`, y una consulta a `perfiles` inmediatamente después devuelve
   `rol === "inversionista"` en menos de 15 segundos desde el envío de las credenciales (SC-003).
   Esta guía no navega a ninguna pantalla — solo confirma que el rol está disponible en la
   respuesta de la API para que un futuro frontend decida qué hacer con él.
3. Repetir con la cuenta de operador del paso 1. **Esperado**: `rol === "operador_banco"`.
4. Intentar `signInWithPassword` con credenciales inexistentes. **Esperado**: `error` no es
   `null` (Historia 2, escenario 3).

## 4. Ver y editar perfil (Historia 3)

1. Con la sesión del inversionista, `select("rol, nombre_completo, telefono, foto_url, wallet_public_key, es_cuenta_demo")`
   sobre `perfiles` (nunca `select("*")`, ver nota en la Sección 1) → **Esperado**: incluye
   nombre, email (desde `session.user.email`), teléfono y `wallet_public_key`.
   Intentar además `select("wallet_secret_id")` o `select("*")` por separado → **Esperado**:
   `403 permission denied for table perfiles` (verificado contra el proyecto real: no está en el
   allow-list de columnas concedido a `authenticated`).
2. `update({ nombre_completo: "Nuevo Nombre", telefono: "988888888" })` sobre la propia fila, sin
   pedir `Prefer: return=representation` completo (o pidiendo `.select()` con columnas explícitas,
   nunca vacío) → **Esperado**: éxito, cambios reflejados en la siguiente lectura.
3. `update({ rol: "operador_banco" })` sobre la propia fila → **Esperado**: rechazado por
   Postgres (falta de privilegio de columna), sin importar que sea la propia cuenta (FR-011,
   SC-004).
4. `update({ wallet_public_key: "GAAAA..." })` sobre la propia fila → **Esperado**: igualmente
   rechazado.

## 5. Cuentas de demostración (Historia 4)

1. Consultar `supabase/seed.sql` o `README.md` para las credenciales conocidas (varios
   inversionistas + 1 operador).
2. `signInWithPassword` directo con una cuenta de demostración de inversionista.
3. **Esperado**: la consulta a `perfiles` devuelve datos ya poblados, incluida una wallet de
   Stellar testnet real y fondeada (no una dirección inventada) — mismo aprovisionamiento que en
   el paso 1, ya ejecutado por el seed.
4. Repetir con la cuenta de demostración de operador.

## Referencias

- Reglas de datos y RLS: [data-model.md](./data-model.md)
- Contratos consumidos: [contracts/auth-api.md](./contracts/auth-api.md),
  [contracts/perfiles-api.md](./contracts/perfiles-api.md),
  [contracts/provision-investor-wallet-function.md](./contracts/provision-investor-wallet-function.md)
- Decisiones técnicas y trade-offs: [research.md](./research.md)
- Esta guía valida exclusivamente la API/backend. La validación de cómo un frontend consume esta
  API (pantallas, navegación por rol) pertenece a la feature de frontend correspondiente, fuera
  de alcance de este plan.
