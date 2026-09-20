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
│   ├── 0001_perfiles.sql                     # tabla perfiles, enum de rol, RLS, privilegios de columna
│   ├── 0002_wallet_provisioning.sql          # triggers de registro, rol inmutable, aprovisionamiento
│   │                                          # de wallet (Database Webhook vía pg_net)
│   ├── 0003_dominio_pools.sql                # empresas, operaciones, pools, tramos
│   ├── 0004_config_edge_functions_url.sql    # URL de Edge Functions configurable por entorno
│   │                                          # (corrige un hallazgo de desarrollo local)
│   ├── 0005_custodia_pools.sql               # cuenta de custodia Stellar dedicada por pool
│   ├── 0006_tipo_cambio.sql                  # tipo de cambio de referencia XLM<->soles/dólares
│   ├── 0007_saldo_demostracion.sql           # saldo de demostración off-chain + recarga
│   ├── 0008_cotizaciones_aportes.sql         # cotizar/reservar/confirmar/revertir aporte, posiciones
│   └── 0009_catalogo_consultas.sql           # catálogo y detalle de pools
├── functions/
│   ├── _shared/
│   │   ├── stellar-keypair.ts                # generar + fondear + custodiar un keypair Stellar
│   │   └── stellar-payment.ts                # balance XLM y pago (Payment) con timeout interno
│   ├── provision-investor-wallet/            # Edge Function: wallet de cada inversionista
│   ├── provision-pool-custody/               # Edge Function: cuenta de custodia de cada pool
│   └── confirmar-aporte/                     # Edge Function: orquesta reserva -> pago -> confirmación
└── seed/
    ├── 00_auth_demo_local.sql                # SOLO LOCAL — cuentas demo en auth.users
    ├── 01_dominio_demo.sql                   # pools, tramos, empresas, operaciones, tipo de cambio
    └── 02_saldos_y_posiciones_demo.sql       # saldo y una posición previa para las cuentas demo
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

### Módulo de pools y primer aporte ([specs/20260920-113925-inversion-pools-aporte/](specs/20260920-113925-inversion-pools-aporte/))

El inversionista recarga saldo de demostración (crédito off-chain en soles/dólares, nunca en
XLM), explora y compara pools de inversión fraccionada sobre facturas de confirming, ve el
detalle de un pool (composición agregada, rendimiento ilustrativo y colchón de pérdida por
tramo), cotiza y confirma un aporte a un tramo (senior o junior), y consulta sus posiciones.
Exclusivamente backend — ver `specs/20260920-113925-inversion-pools-aporte/contracts/` para el
contrato de cada operación, y
[frontend-integration.md](specs/20260920-113925-inversion-pools-aporte/frontend-integration.md)
para una guía práctica de integración (explorar, saldo/recarga, cotizar y confirmar un aporte,
posiciones, y el registro completo de códigos de error).

Piezas clave:
- **Entidades del dominio** (`empresas_pagadoras`, `operaciones`, `pools`, `tramos`): sin ningún
  privilegio directo para `anon`/`authenticated` — todo el acceso de cliente pasa por
  `catalogo_pools()`/`detalle_pool()`, que nunca exponen una operación o empresa individual.
- **Custodia por pool**: cada pool tiene su propia cuenta de Stellar testnet dedicada (mismo
  patrón de wallet de inversionista: keypair + Friendbot + Vault), para que el capital custodiado
  de un pool sea directamente el balance de su cuenta en Horizon, sin lógica de memos, y para que
  la custodia pueda migrar a un contrato Soroban más adelante cambiando solo un valor, no el
  contrato de API.
- **Saldo de demostración** (`saldos_demostracion`, `recargas_saldo`): crédito off-chain con tope
  de S/1000 (o equivalente en USD) por día natural en hora de Lima, compartido entre monedas y
  seguro ante recargas simultáneas (`pg_advisory_xact_lock`).
- **Aporte** (`cotizaciones`, `aportes`): ciclo `reservado -> confirmado | revertido`. El cupo de
  un tramo se compromete de forma atómica (`UPDATE` condicional de una sola sentencia) en el
  momento de la reserva, nunca al confirmar — así ningún aporte concurrente puede sobrevender un
  tramo. La Edge Function `confirmar-aporte` orquesta de forma síncrona reserva → pago real en
  XLM testnet → confirmación con el hash o reversión, con un timeout interno de 25s.
- **Registro de códigos de error estables** (`PA001`-`PA013`, expuestos como `error.code` vía
  PostgREST) — ver `specs/20260920-113925-inversion-pools-aporte/data-model.md`.
- **Hallazgos de desarrollo local** (corregidos, ver `research.md` §2 y §6 de esa feature): el
  webhook de aprovisionamiento de wallet de la feature previa tenía la URL de producción
  hardcodeada y el secreto compartido nunca se había versionado — ambos corregidos en
  `0004_config_edge_functions_url.sql` sin editar la migración `0002` ya aplicada; y una colisión
  conocida de *sequence number* de Stellar cuando la misma billetera somete varios pagos
  concurrentemente (no afecta el invariante de cupo, solo cuántos intentos legítimos se confirman
  al primer intento).

## Cuentas de demostración

Precargadas por `supabase/seed/00_auth_demo_local.sql` (solo local — en el proyecto remoto ya
existen de verdad) para explorar la plataforma sin registrarse (no son funcionalidad de producto,
solo datos de prueba — ver spec.md > Assumptions). Las contraseñas no se tratan como secretas.

| Rol | Email | Contraseña |
|---|---|---|
| Inversionista | `inversionista.demo1@paul.test` | `DemoStellar2026!` |
| Inversionista | `inversionista.demo2@paul.test` | `DemoStellar2026!` |
| Inversionista | `inversionista.demo3@paul.test` | `DemoStellar2026!` |
| Operador de banco | `operador.demo@paul.test` | `DemoStellar2026!` |

Las 3 cuentas de inversionista tienen una wallet de Stellar testnet real y fondeada (no una
dirección inventada), generada por el mismo flujo de aprovisionamiento que usa el registro real,
saldo de demostración inicial, y `inversionista.demo1` tiene además una posición previa ya
confirmada (`supabase/seed/02_saldos_y_posiciones_demo.sql`) para poder mostrar "mis posiciones"
sin esperar. Los ≥5 pools ficticios de ejemplo (`supabase/seed/01_dominio_demo.sql`) cubren
distintos plazos, monedas, perfiles de riesgo, sectores y estados de avance de fondeo (uno casi
vacío, uno a medio fondear, uno casi lleno, uno completamente fondeado).

## Desarrollo

- Requiere el [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
  (ya incluido como dependencia de desarrollo en `package.json`).
- Copiar `.env.example` a `.env` y completar los valores reales (nunca commitear `.env`).

## Frontend web

La aplicación React está en `apps/web`. Incluye acceso y registro, panel principal, catálogo y
detalle de pools, saldo y recarga de demostración, flujo de cotización/aporte, posiciones, perfil
y wallet. La interfaz consume directamente los contratos Supabase documentados en `specs/`.

1. Copiar `apps/web/.env.example` como `apps/web/.env`.
2. Completar `VITE_SUPABASE_ANON_KEY` con la clave pública `anon`/`publishable` del proyecto.
3. Instalar y ejecutar desde la raíz:

```bash
npm install
npm run dev
```

El frontend queda disponible en `http://127.0.0.1:4173`. Nunca se debe colocar
`SUPABASE_SERVICE_ROLE_KEY` en `apps/web/.env` ni en código cliente.

Si todavía no se cuenta con la clave pública, la pantalla de configuración permite abrir una
vista previa local con datos ficticios. Este modo solo existe durante desarrollo y no reemplaza
las pruebas contra Supabase.

### Despliegue en Vercel

El proyecto se despliega desde la raíz del repositorio. `vercel.json` configura el build del
workspace y las rutas de React Router.

- Root Directory: `.` (raíz del repositorio)
- Framework Preset: `Vite`
- Install Command: `npm ci`
- Build Command: `npm run build`
- Output Directory: `apps/web/dist`

Agregar en Vercel para Production, Preview y Development:

- `VITE_SUPABASE_URL=https://qqpozotcrxfukkwcoget.supabase.co`
- `VITE_SUPABASE_ANON_KEY=<clave anon/publishable del proyecto>`

Después de crear o modificar variables, es necesario iniciar un nuevo deployment para que Vite
las incorpore durante el build.
