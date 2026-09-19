# Contrato: Tabla `perfiles` (PostgREST auto-generado, protegido por RLS)

No hay un backend custom para leer/editar el perfil — se usa la API REST que Supabase genera
automáticamente sobre la tabla, restringida por RLS y privilegios de columna (ver `research.md`
§5 y `data-model.md`).

## Leer el propio perfil (US3, ver perfil)

```ts
const { data, error } = await supabase
  .from("perfiles")
  .select("rol, nombre_completo, telefono, foto_url, wallet_public_key, es_cuenta_demo")
  .eq("id", session.user.id)
  .single();
```

- RLS garantiza que solo se puede leer la fila donde `id = auth.uid()` — cualquier otro `id` en el
  filtro devuelve cero filas, no un error (comportamiento estándar de RLS).
- `wallet_public_key` es `NULL` mientras el aprovisionamiento asíncrono no haya terminado (ver
  ciclo de vida en `data-model.md`) — es un estado válido de la API que cualquier consumidor debe
  interpretar como "en progreso", no como error. `rol` en cambio nunca es `NULL`.
- `wallet_secret_id` **no debería incluirse** en el `select` de ningún cliente consumidor — se
  documenta aquí como regla de uso del contrato, aunque de todas formas queda protegido a nivel
  de base de datos (ver más abajo).

## Editar el propio perfil (US3, editar perfil)

```ts
const { data, error } = await supabase
  .from("perfiles")
  .update({ nombre_completo, telefono, foto_url })
  .eq("id", session.user.id)
  .select("nombre_completo, telefono, foto_url") // nunca .select() vacío: pide select=* y
  .single();                                      // wallet_secret_id no está en el allow-list
```

- **Importante**: `.select()` sin argumentos pide todas las columnas (`select=*`) a PostgREST, lo
  que incluiría `wallet_secret_id` y haría fallar la operación completa con `permission denied`
  (verificado en T018 contra el proyecto real) — cualquier cliente que llame a este contrato debe
  listar explícitamente las columnas que necesita de vuelta, nunca `.select()` vacío.
- **Éxito**: fila actualizada devuelta (con las columnas explícitamente pedidas).
- **Intento de incluir `rol`, `wallet_public_key`, `wallet_secret_id` o `es_cuenta_demo` en el
  `update`**: Postgres rechaza la operación completa (`permission denied for table perfiles`) por
  falta de privilegio de columna — el allow-list de `GRANT UPDATE` solo cubre
  `nombre_completo`/`telefono`/`foto_url` (ver `research.md` §5). No es una validación de
  aplicación: el cliente nunca debería enviar esos campos, pero si lo hiciera, la base de datos
  los bloquea igual (FR-011, SC-004).

## Nunca expuesto por este contrato

- `vault.secrets` / `vault.decrypted_secrets`: sin grants para `anon`/`authenticated`; no
  alcanzable desde `supabase-js` por ningún cliente, sea cual sea la feature de frontend que lo
  use.
- `perfiles.wallet_secret_id`: excluida del allow-list de `GRANT SELECT` de columna a
  `authenticated` (ver `research.md` §5) — un `select("wallet_secret_id")` o un `select("*")`
  desde cualquier cliente autenticado falla, no solo se desaconseja por convención. El dato
  sensible en sí (la llave privada) sigue además inalcanzable porque vive únicamente en
  `vault.secrets`.
