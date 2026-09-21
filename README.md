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
│   ├── 0010_configuracion_red.sql            # tabla de configuración por red Stellar (contrato)
│   ├── 0011_proveedores_facturas.sql         # proveedores; rename operaciones->facturas + ciclo
│   │                                          # de vida de originación; columnas nuevas de tramos
│   ├── 0012_registro_y_asignacion_facturas.sql  # registrar_factura, asignar_factura_a_pool,
│   │                                          # confirmar/revertir_asignacion_factura
│   ├── 0013_facturas_del_pool_y_detalle.sql  # facturas_del_pool, detalle_pool extendido,
│   │                                          # actualizar_estado_cobro_factura
│   ├── 0014_provision_pool_tramo_token.sql   # trigger + Database Webhook por tramo nuevo
│   └── 0015_mint_fracciones_aporte.sql       # soporte de emisión de fracciones + compensación
├── functions/
│   ├── _shared/
│   │   ├── stellar-keypair.ts                # generar + fondear + custodiar un keypair Stellar
│   │   ├── stellar-payment.ts                # balance XLM y pago (Payment) con timeout interno
│   │   └── stellar-soroban.ts                # invocar contratos Soroban con reintentos + lectura
│   ├── provision-investor-wallet/            # Edge Function: wallet de cada inversionista
│   ├── provision-pool-custody/               # Edge Function: cuenta de custodia de cada pool
│   ├── provision-pool-tramo-token/           # Edge Function: instancia el contrato de un tramo
│   ├── confirmar-aporte/                     # Edge Function: reserva -> pago -> mint -> confirmación
│   └── asignar-factura/                      # Edge Function: asigna una factura -> contrato
└── seed/
    ├── 00_auth_demo_local.sql                # SOLO LOCAL — cuentas demo en auth.users
    ├── 01_dominio_demo.sql                   # pools, tramos, empresas, operaciones, tipo de cambio
    ├── 02_saldos_y_posiciones_demo.sql       # saldo y una posición previa para las cuentas demo
    └── 03_originacion_facturas_demo.sql      # facturas de ejemplo en varios estados de cobro

contracts/
├── soroban-pool/                             # contrato Soroban (Rust) — un WASM, una instancia
│                                              # por tramo (senior/junior de cada pool)
├── scripts/deploy.sh                         # sube el WASM, instancia por tramo, publica config
└── deployments/testnet.json                  # IDs de contrato + wasm_hash desplegados (sin secretos)
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

### Módulo de originación de facturas y tokenización ([specs/20260920-174938-originacion-facturas-pool/](specs/20260920-174938-originacion-facturas-pool/))

Un operador de banco registra y valida facturas de demostración (sin documento real) y las asigna
manualmente a un pool/tramo definiendo un anticipo por factura — el fraccionamiento del tramo sale
de la suma acumulada de anticipos, redondeada hacia abajo a la unidad mínima del pool (el residuo
queda como reserva, sin rechazar ninguna factura). Cada tramo de cada pool se representa on-chain
como una instancia propia de un contrato Soroban (`pool_fraction_token`, interfaz SEP-41 completa,
1 fracción = 1 unidad mínima) que es la fuente de verdad: registra la huella de cada factura
(nunca sus datos) y emite fracciones a un inversionista solo después de que su aporte ya se pagó
en XLM real. El inversionista ve las facturas de cada pool en versión anonimizada (nunca proveedor
ni deudor) junto con hechos de estado de cobro, sin ningún cálculo de rendimiento. Exclusivamente
backend/contrato — ver `specs/20260920-174938-originacion-facturas-pool/contracts/` para el
contrato de cada operación y del contrato inteligente.

Piezas clave:
- **`facturas`** (renombrada desde `operaciones`): ciclo de vida completo de originación —
  registro/validación (`registrar_factura`), asignación con anticipo (`asignar_factura_a_pool`),
  y confirmación on-chain (`confirmar_asignacion_factura`). Una factura rechazada por datos
  incoherentes nunca se persiste; solo queda un registro `'rechazada'` cuando el dato en sí es
  coherente pero duplicado.
- **Contrato `pool_fraction_token`** (`contracts/soroban-pool/`): una instancia por tramo,
  `decimals = 0`, admin-only `register_invoice`/`mint` con cupo (`Cap`) que nunca decrece ni se
  excede — la garantía on-chain vive en el propio contrato, no solo en Postgres.
- **El contrato manda**: un aporte solo se confirma en Supabase después de que el contrato emitió
  las fracciones; si el contrato falla de forma definitiva tras el pago en XLM, la Edge Function
  `confirmar-aporte` compensa automáticamente (reembolso XLM custodia→inversionista) antes de
  revertir — nunca queda un aporte a medias.
- **Estado real de esta feature**: todas las migraciones (0010–0015) y las 3 Edge Functions están
  desplegadas, y el flujo completo — incluida la capa on-chain — está **validado en vivo contra
  el proyecto y contra Stellar testnet real**. El contrato Soroban (`pool_fraction_token`) está
  compilado (`cargo test`: 9/9 pruebas OK) y desplegado: una instancia por cada uno de los 12
  tramos existentes (6 pools × senior/junior). Evidencia versionada en
  `contracts/deployments/testnet.json`:
  - **`wasm_hash`**: `25af11fb4fc9febd1cf91991a8127e8f9d0b1d3b3467a6f39c8b69304b33f0ca`
  - **Contrato de ejemplo** (POOL-PEN-002 / senior): `CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO`
  - **Transacción real de `register_invoice`** sobre ese contrato (factura de seed asignada en
    vivo a través de la Edge Function `asignar-factura`, no un placeholder):
    [`f4f276878251d6bd18745263af2d99126d35c852649f19639ceceaa4e82fbe80`](https://stellar.expert/explorer/testnet/tx/f4f276878251d6bd18745263af2d99126d35c852649f19639ceceaa4e82fbe80)
  - Verificable de forma independiente: `stellar contract invoke --id CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO --source <cualquier-cuenta> --network testnet --send=no -- cap` devuelve `312` (= 3200 PEN / 100 unidad mínima del pool).
  - **Aporte de inversionista de extremo a extremo**, también real (vía `confirmar-aporte`): pago
    en XLM
    ([`bf94488143dadffaf197d0930da0ba6f965821820336e400e2cec4bf8845fc38`](https://stellar.expert/explorer/testnet/tx/bf94488143dadffaf197d0930da0ba6f965821820336e400e2cec4bf8845fc38))
    seguido de `mint` on-chain
    ([`126d725275572e8f31716c7a1042e3be82a454f709aa1720bcd43814bfcbc8bb`](https://stellar.expert/explorer/testnet/tx/126d725275572e8f31716c7a1042e3be82a454f709aa1720bcd43814bfcbc8bb)) —
    `balance()` del inversionista quedó en `1` (100 PEN / 100 unidad mínima), `total_supply()` en
    `1`, `cap()` sin cambios en `312`.
  - Bugs reales encontrados y corregidos durante esta validación — ver
    `supabase/functions/_shared/stellar-soroban.ts` para el detalle exacto de cada uno:
    1. Deno no expone el global `Buffer` de Node (`Buffer is not defined`).
    2. **Crítico**: `@stellar/stellar-sdk@^13` no puede parsear `getTransaction()` contra una red
       en protocolo 28 (`Bad union switch: 4` al leer la meta de la transacción). Esto hacía que
       toda invocación exitosa lanzara una excepción justo después de confirmarse on-chain,
       disparando reintentos que sometían la misma operación varias veces más — inofensivo para
       `register_invoice` (el contrato deduplica por huella), pero causó una emisión **duplicada
       real** de fracciones con `mint` (que no tiene esa protección) antes de detectarse. Las
       fracciones fantasma se quemaron (`burn`) para reconciliar el estado, y el pago
       correspondiente ya se había reembolsado automáticamente. Corregido subiendo a
       `@stellar/stellar-sdk@^17` en los 3 archivos que lo usan, verificado con una repetición
       limpia del mismo aporte (evidencia de arriba).

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
2. Completar `VITE_SUPABASE_PUBLISHABLE_KEY` con la clave pública `publishable` del proyecto.
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
- `VITE_SUPABASE_PUBLISHABLE_KEY=<clave publishable del proyecto>`

Después de crear o modificar variables, es necesario iniciar un nuevo deployment para que Vite
las incorpore durante el build.
