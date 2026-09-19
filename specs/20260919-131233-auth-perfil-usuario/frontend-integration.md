# Guía de integración para frontend: Registro, Login y Perfil

Manual práctico para quien construya la app móvil (inversionista) o el panel web (operador de
banco). Esta feature **es exclusivamente backend** — no expone ningún endpoint HTTP propio ni
requiere la CLI de Supabase en el cliente. Todo se consume con el SDK `@supabase/supabase-js`
contra la API que Supabase genera automáticamente (Auth + PostgREST). Los contratos detallados
están en [contracts/](./contracts/); esta guía es la versión "cómo lo uso" de esos mismos
contratos.

## 0. Lo primero que hay que entender

- **No hay backend custom que llamar.** No existe un endpoint tipo `POST /api/registro`. Todo pasa
  por `supabase.auth.*` (registro/login) y `supabase.from("perfiles")` (leer/editar perfil), que
  hablan directo con Supabase desde el propio cliente (móvil o web).
- **No se necesita la CLI de Supabase.** La CLI (`supabase db push`, `supabase functions deploy`)
  la usa quien mantiene el backend (`/supabase` en este repo), no el frontend.
- **Login es exclusivamente email/contraseña.** No hay botón de Google ni ningún otro proveedor
  OAuth — fue una decisión explícita del equipo (ver `spec.md` → Fuera de Alcance).
- El **rol no se elige en el login, se fija una sola vez al registrarse** y no puede cambiar nunca
  después. El frontend nunca ofrece un selector de rol post-registro.

## 1. Setup del cliente

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://qqpozotcrxfukkwcoget.supabase.co", // SUPABASE_URL
  "<SUPABASE_ANON_KEY>", // la anon/publishable key — no es secreta, es la pensada para el cliente
);
```

Ambos valores están en `.env.example` (raíz del repo). La `anon key` es pública por diseño: es la
que se embebe en apps móviles/web. Nunca uses la `SUPABASE_SERVICE_ROLE_KEY` en el frontend — esa
es solo para scripts de servidor.

`supabase-js` guarda la sesión automáticamente (localStorage en web, `AsyncStorage`/`SecureStore`
en Expo — configurar `auth.storage` al crear el cliente en React Native). Para saber si hay sesión
activa al abrir la app:

```ts
const { data: { session } } = await supabase.auth.getSession();
```

## 2. Registro

```ts
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    data: {
      rol: "inversionista", // o "operador_banco" — obligatorio, lo decide la pantalla de registro
      nombre_completo: nombre,
      telefono, // opcional, solo tiene sentido para inversionista
    },
  },
});
```

- El `rol` **debe** ir en `options.data` desde el propio formulario de registro (ej. dos flujos de
  registro distintos, o un selector antes del formulario). Si no se manda, el registro falla — no
  hay valor por defecto.
- **Éxito**: `data.user.id` presente. El perfil (`public.perfiles`) ya existe en ese mismo
  instante, con el rol fijado.
- **Error — email ya registrado** (`error.message` tipo "user already exists" /
  `user_already_exists`): mostrar "ese email ya tiene una cuenta". Nota: si la confirmación de
  email está activa, Supabase a veces responde éxito (200) sin crear cuenta nueva, como protección
  anti-enumeración — no asumas que un 200 siempre significa "cuenta nueva creada"; confía en que el
  usuario ya recibió instrucciones si el email existía.
- **Error — rate limit de envío de email** (`over_email_send_rate_limit`, código 429): puede
  ocurrir en el plan gratuito de Supabase bajo pruebas repetidas. Mostrar "intenta de nuevo en unos
  minutos", no un error genérico de registro fallido.

## 3. Login

```ts
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
```

- **Error** (credenciales inválidas): `error.message` estándar de Supabase Auth — mostrar "email o
  contraseña incorrectos", sin distinguir cuál de los dos falló (no filtrar si el email existe).
- **Éxito**: hay sesión (`data.session`). El siguiente paso siempre es leer el perfil para saber el
  rol — el login por sí solo no dice a qué experiencia mandar a la persona.

## 4. Leer el perfil y decidir la pantalla según el rol

```ts
const { data: perfil, error } = await supabase
  .from("perfiles")
  .select("rol, nombre_completo, telefono, foto_url, wallet_public_key, es_cuenta_demo")
  .eq("id", data.session.user.id)
  .single();
```

- `perfil.rol` es `"inversionista"` o `"operador_banco"` — **nunca `null`**. Úsalo para decidir a
  qué navegación mandar a la persona justo después del login/registro.
- `perfil.wallet_public_key` es `null` un momento después de que un inversionista se registra (el
  aprovisionamiento de la wallet es asíncrono, tarda unos segundos). Es un estado válido, no un
  error — ver sección 5.
- Para operador de banco, `wallet_public_key` siempre es `null` (los operadores no tienen wallet).

## 5. Wallet del inversionista: qué hacer con el estado "todavía no existe"

Justo después del registro de un inversionista, la wallet se genera en segundo plano (se crea el
par de llaves, se funda en Stellar testnet vía Friendbot, y se guarda la llave privada cifrada en
el backend). Esto tarda **unos segundos**, no es instantáneo.

Opción simple (recomendada para la demo de una semana) — **polling** justo después del registro:

```ts
async function esperarWallet(userId: string, intentos = 10, esperaMs = 2000) {
  for (let i = 0; i < intentos; i++) {
    const { data: perfil } = await supabase
      .from("perfiles")
      .select("wallet_public_key")
      .eq("id", userId)
      .single();
    if (perfil?.wallet_public_key) return perfil.wallet_public_key;
    await new Promise((r) => setTimeout(r, esperaMs));
  }
  return null; // mostrar "tu wallet se está preparando, vuelve en un momento" y reintentar luego
}
```

Muestra una pantalla de "preparando tu wallet..." mientras `wallet_public_key` es `null`, en vez de
tratarlo como un error. No hay forma de "apurar" el proceso desde el frontend.

(Alternativa más elegante: suscribirse con Supabase Realtime a cambios en la fila de `perfiles`
propia. No está configurado ni probado en este backend — si se necesita, es un cambio de
infraestructura a coordinar con quien mantiene `/supabase`, no algo que el frontend pueda activar
por su cuenta.)

## 6. Editar perfil

```ts
const { data, error } = await supabase
  .from("perfiles")
  .update({ nombre_completo, telefono, foto_url })
  .eq("id", session.user.id)
  .select("nombre_completo, telefono, foto_url") // nunca .select() vacío, ver aviso abajo
  .single();
```

**Solo `nombre_completo`, `telefono` y `foto_url` son editables.** Cualquier otro campo
(`rol`, `wallet_public_key`, `wallet_secret_id`, `es_cuenta_demo`, `email`) es rechazado por la
base de datos aunque el formulario intente enviarlo — no confíes solo en ocultar el campo en la
UI, la base de datos ya lo bloquea, pero tampoco lo mandes en el `update` porque hace fallar toda
la operación (ver siguiente aviso).

> ⚠️ **Nunca uses `.select()` sin argumentos** (ni en `update` ni en ningún `select`) sobre
> `perfiles`. Sin columnas explícitas, `supabase-js` pide todas las columnas (`select=*`), lo que
> incluye `wallet_secret_id` — una columna a la que ningún cliente tiene acceso — y hace fallar
> **toda** la petición con `permission denied`, incluso si el resto de la operación era válida.
> Siempre lista las columnas que necesitas.

## 7. Qué nunca vas a poder leer (y está bien así)

- `wallet_secret_id` y la llave privada de Stellar en sí **nunca son accesibles desde el
  frontend**, bajo ningún usuario ni rol. La llave privada vive únicamente en el backend (Supabase
  Vault) y firma transacciones desde ahí. Si algún día se necesita firmar algo desde el cliente,
  es una conversación de diseño nueva, no una llave que se pueda simplemente "pedir".
- Intentar `select("wallet_secret_id")` o `select("*")` devuelve `403 permission denied` — es
  esperado, no un bug que reportar.

## 8. Cuentas de demostración

Para probar la UI sin pasar por el flujo de registro real (y sin chocar con el límite de envío de
email del plan gratuito), usa las cuentas precargadas — credenciales en el `README.md` del repo.
Las 3 cuentas de inversionista demo ya tienen wallet real y fondeada en testnet; úsalas para
construir/probar las pantallas de wallet sin esperar el aprovisionamiento asíncrono.

## 9. Checklist rápido

- [ ] `rol` va en `signUp()`, nunca se elige después.
- [ ] Después de login/registro, siempre se lee `perfiles` para saber a qué pantalla mandar según
      `rol`.
- [ ] `wallet_public_key === null` en un inversionista recién registrado es normal — mostrar
      estado de carga, no error.
- [ ] Nunca `.select()` vacío sobre `perfiles`.
- [ ] Nunca intentar leer o editar `wallet_secret_id`, `rol` o `es_cuenta_demo`.
- [ ] Nunca ofrecer login social — no existe.

## Referencias

- [contracts/auth-api.md](./contracts/auth-api.md) — contrato formal de Auth
- [contracts/perfiles-api.md](./contracts/perfiles-api.md) — contrato formal de la tabla `perfiles`
- [data-model.md](./data-model.md) — campos, reglas y ciclo de vida completos
- [quickstart.md](./quickstart.md) — misma validación que corrió el backend, útil como referencia
  de qué comportamiento es "correcto" si algo no coincide en el frontend
