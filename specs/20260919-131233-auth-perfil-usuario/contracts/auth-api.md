# Contrato: Autenticación (Supabase Auth)

Superficie de API que este plan entrega, tal como la consumiría **cualquier** cliente futuro
(móvil, web, u otro) vía `@supabase/supabase-js` — ese cliente se construye en una feature de
frontend separada, fuera de este plan. No es un endpoint custom: es el contrato de la API nativa
de Supabase Auth tal como la usa esta feature. **Único método soportado: email/contraseña** — el
equipo decidió explícitamente no incorporar login social (Google u otro proveedor OAuth).

## Registro con email/contraseña

```ts
const { data, error } = await supabase.auth.signUp({
  email,
  password,
  options: {
    data: {
      rol: "inversionista" | "operador_banco", // obligatorio, explícito en cada solicitud (FR-002)
      nombre_completo: string,
      telefono?: string, // solo inversionista
    },
  },
});
```

- **Éxito**: `data.user` con `id`/`email`; el trigger `handle_new_user()` crea la fila en
  `public.perfiles` de forma síncrona con `rol` ya fijado.
- **Error — email duplicado** (FR-013): `error.message` indica que el usuario ya existe (código
  estándar de Supabase Auth, ej. `user_already_exists`) — el consumidor de la API decide cómo
  mostrarlo.

## Login con email/contraseña

```ts
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
```

- **Error — credenciales inválidas**: `error.message` estándar de Supabase Auth (Historia 2,
  escenario 3).

## Obtener el rol tras cualquier login exitoso

```ts
const { data: perfil } = await supabase
  .from("perfiles")
  .select("rol, nombre_completo, telefono, foto_url, wallet_public_key")
  .eq("id", session.user.id)
  .single();
```

- `perfil.rol` es el dato que expone esta API para que un frontend (fuera de alcance) decida a
  qué experiencia dirigir a la persona (FR-008) — este plan no implementa esa decisión ni ninguna
  navegación. `perfil.rol` nunca es `NULL`: toda cuenta existente tiene su rol fijado desde el
  momento del registro.
