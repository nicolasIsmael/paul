# Data Model: Registro, Inicio de Sesión y Perfil de Usuario

## Entidades

### `auth.users` (gestionada por Supabase Auth — no se migra manualmente)

Identidad autenticable base. Relevante para este modelo:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | uuid | PK, referenciado por `public.perfiles.id` |
| `email` | text | único, gestionado por Supabase Auth; nunca editable desde este flujo |
| `raw_user_meta_data` | jsonb | contiene `{ rol, nombre_completo, telefono }` pasados en `options.data` de `signUp()` — único método de registro soportado (sin login social) |

### `public.perfiles`

Perfil único por cuenta, cubre tanto inversionista como operador de banco (campos no aplicables
quedan en `null` según el rol — ver §Un Solo Modelo de Datos Genérico en la constitución: se
prefiere una tabla con campos condicionales por rol antes que dos tablas separadas, ya que ambos
roles comparten la misma identidad 1:1 con `auth.users`).

| Campo | Tipo | Reglas |
|---|---|---|
| `id` | uuid | PK, FK → `auth.users.id` on delete cascade |
| `rol` | `perfil_rol` (enum: `inversionista`, `operador_banco`), **NOT NULL** | Se fija en el mismo `signUp()` que crea la cuenta (research.md §4) y es **inmutable para siempre** desde ese instante (trigger `perfiles_rol_inmutable`, FR-003) — sin login social no hay ningún estado transitorio sin rol que gestionar |
| `nombre_completo` | text | NOT NULL |
| `telefono` | text | NULL (solo inversionista, FR-004); NULL para operador |
| `foto_url` | text | NULL, editable (FR-010) |
| `wallet_public_key` | text | NULL hasta que el aprovisionamiento asíncrono lo complete; solo se usa cuando `rol = 'inversionista'`; dato público (FR-009) |
| `wallet_secret_id` | uuid | NULL hasta el aprovisionamiento; referencia a `vault.secrets.id`; **nunca se expone vía API pública** (FR-014) — excluida del `GRANT SELECT` de columnas a `authenticated` (ver research.md §5: un `REVOKE` de columna aislado no basta en Supabase, hace falta revocar la tabla completa y conceder solo un allow-list); solo se usa cuando `rol = 'inversionista'` |
| `es_cuenta_demo` | boolean | NOT NULL default `false`; `true` para las cuentas precargadas de la Historia 4 |
| `created_at` | timestamptz | NOT NULL default `now()` |
| `updated_at` | timestamptz | NOT NULL default `now()`, actualizado por trigger en cada `UPDATE` |

**Validación**: check constraint `wallet_fields_solo_inversionista` — `wallet_public_key` y
`wallet_secret_id` deben ser `NULL` cuando `rol = 'operador_banco'`.

**Campos editables por el propio usuario** (FR-010, FR-011): únicamente `nombre_completo`,
`telefono`, `foto_url` — reforzado con un allow-list de `GRANT UPDATE` de columna (tras revocar
el privilegio de tabla completo) sobre el resto (ver `research.md` §5), no solo con validación de
aplicación.

### `vault.secrets` (built-in de Supabase Vault — no se migra manualmente)

Almacena el secreto (`secret key` de Stellar) cifrado en reposo. Solo se interactúa con ella desde
la Edge Function `provision-investor-wallet` mediante `service_role`:

| Campo relevante | Uso |
|---|---|
| `id` | referenciado por `perfiles.wallet_secret_id` |
| `secret` (cifrado en disco) / `decrypted_secret` (vía vista `vault.decrypted_secrets`) | la llave privada Stellar; nunca sale de Vault salvo para firmar transacciones desde el backend |

## Relaciones

```
auth.users (1) ──── (1) public.perfiles ──── (0..1) vault.secrets
   Supabase Auth        rol, datos de perfil      llave privada cifrada
                         wallet_secret_id ─────────────┘  (solo si rol=inversionista)
```

## Ciclo de vida / transiciones de estado

1. **Registro (email/contraseña, único método soportado)**: `auth.users` insert (con
   `raw_user_meta_data` completo, incluido `rol`) → trigger crea `perfiles` con `rol` ya fijado y
   `wallet_public_key`/`wallet_secret_id` en `NULL` si `rol = 'inversionista'` → Database Webhook
   dispara `provision-investor-wallet` → `UPDATE perfiles SET wallet_public_key = ...,
   wallet_secret_id = ...`.
2. **Perfil incompleto transitorio**: entre el paso 1 y que `provision-investor-wallet` termine,
   `perfiles.wallet_public_key` es `NULL` para un inversionista — es un estado válido y esperado
   de la API, no un error, queda documentado en `contracts/` para que quien consuma esta API
   (fuera de alcance de este plan) sepa interpretarlo. `perfiles.rol` en cambio nunca es `NULL`:
   se fija de forma atómica en el mismo insert.
3. **Edición de perfil (US3)**: `UPDATE perfiles SET nombre_completo/telefono/foto_url ...` — el
   intento de tocar `rol`, `wallet_public_key`, `wallet_secret_id` o `es_cuenta_demo` es rechazado
   por Postgres a nivel de privilegios de columna, no por lógica de aplicación.
4. **Cuenta de demostración (US4)**: mismas tablas, `es_cuenta_demo = true`, `rol` ya fijado
   directamente por `supabase/seed.sql`, con el mismo flujo de aprovisionamiento (para que la
   wallet de demo también sea real en testnet, no una dirección inventada).
