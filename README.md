# Paul

Plataforma de fraccionamiento de activos financieros sobre Stellar — proyecto para el hackathon
**Stellar Odyssey Perú 2026**. Ver [.specify/memory/constitution.md](.specify/memory/constitution.md)
para los principios que rigen el proyecto.

## Arquitectura

Todo el backend vive versionado en este repositorio (Principio VII de la constitución: ningún
objeto de base de datos se crea o modifica desde el Dashboard de Supabase como fuente de verdad).

```text
supabase/
├── migrations/
│   ├── 0001_perfiles.sql              # tabla perfiles, enum de rol, RLS, privilegios de columna
│   └── 0002_wallet_provisioning.sql   # triggers de registro, rol inmutable, aprovisionamiento
│                                       # de wallet (Database Webhook vía pg_net)
├── functions/
│   └── provision-investor-wallet/     # Edge Function: genera keypair, funda con Friendbot,
│       └── index.ts                   # guarda la llave privada en Supabase Vault
└── seed.sql                           # cuentas de demostración precargadas
```

Proyecto Supabase: **Stellar Odyssey** (`qqpozotcrxfukkwcoget`).

### Módulo de autenticación y perfil ([specs/20260919-131233-auth-perfil-usuario/](specs/20260919-131233-auth-perfil-usuario/))

Registro y login exclusivamente con email/contraseña (sin login social — decisión explícita del
equipo) con rol fijo inversionista/operador de banco, perfil consultable/editable, y wallet de
Stellar testnet real y custodiada por la plataforma para cada inversionista. Es exclusivamente
backend — ningún frontend se construye en esta feature; ver
`specs/20260919-131233-auth-perfil-usuario/contracts/` para el contrato de API que consumirá el
frontend (a construirse en una feature separada), y
[frontend-integration.md](specs/20260919-131233-auth-perfil-usuario/frontend-integration.md) para
una guía práctica de cómo integrarlo (registro, login, perfil, wallet) sin necesidad de leer todo
el spec.

Piezas clave:
- **`public.perfiles`**: perfil 1:1 con `auth.users`, con `rol` (`NOT NULL`, fijado en el propio
  registro) inmutable para siempre.
- **Custodia de wallet**: la llave privada de Stellar vive únicamente en Supabase Vault
  (`vault.secrets`), referenciada por `perfiles.wallet_secret_id` (nunca legible vía la API
  pública). El aprovisionamiento es asíncrono: un trigger en `perfiles` invoca, vía `pg_net`, la
  Edge Function `provision-investor-wallet`, que genera el keypair, lo funda con Friendbot y
  guarda el secreto.
- **Funciones `SECURITY DEFINER`** (`aprovisionar_wallet_inversionista`,
  `obtener_shared_secret_webhook`) tienen sus privilegios de ejecución restringidos
  explícitamente — ver `specs/20260919-131233-auth-perfil-usuario/research.md` §5 para el detalle
  de por qué esto requirió una corrección durante la implementación.

## Cuentas de demostración

Precargadas por `supabase/seed.sql` para explorar la plataforma sin registrarse (no son
funcionalidad de producto, solo datos de prueba — ver spec.md > Assumptions). Las contraseñas no
se tratan como secretas.

| Rol | Email | Contraseña |
|---|---|---|
| Inversionista | `inversionista.demo1@paul.test` | `DemoStellar2026!` |
| Inversionista | `inversionista.demo2@paul.test` | `DemoStellar2026!` |
| Inversionista | `inversionista.demo3@paul.test` | `DemoStellar2026!` |
| Operador de banco | `operador.demo@paul.test` | `DemoStellar2026!` |

Las 3 cuentas de inversionista tienen una wallet de Stellar testnet real y fondeada (no una
dirección inventada), generada por el mismo flujo de aprovisionamiento que usa el registro real.

## Desarrollo

- Requiere el [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  (ya incluido como dependencia de desarrollo en `package.json`).
- Copiar `.env.example` a `.env` y completar los valores reales (nunca commitear `.env`).
