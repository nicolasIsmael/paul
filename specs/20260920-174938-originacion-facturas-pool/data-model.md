# Data Model: Originación de Facturas y Tokenización de Fracciones de Pool

Convención de dinero heredada sin cambios (spec previa, `data-model.md` §1): nunca `float`, solo
`numeric` — soles/dólares en `numeric(14,2)`, XLM en `numeric(20,7)`. Las fracciones on-chain, en
cambio, son enteros puros (`i128` en el contrato, `integer` en Postgres) — nunca `numeric`, porque
1 fracción = 1 `unidad_minima_aporte` exacta (`research.md` §1); no existe la fracción de una
fracción.

**Acceso**: mismo patrón deny-all de la feature previa. `facturas` y `proveedores` habilitan RLS
sin políticas y revocan privilegios de tabla a `anon`/`authenticated`; todo acceso de cliente pasa
por funciones `security definer` nuevas (`registrar_factura`, `facturas_del_pool`, etc.) — así se
garantiza a nivel de base de datos, no de disciplina de cliente, que un inversionista nunca puede
leer `proveedores.nombre_comercial` ni `empresas_pagadoras.nombre_comercial` (FR-020/FR-021).

## Registro de códigos de error (continúa desde `PA013`, spec previa)

Mismo esquema: `raise exception using errcode = '<código>'`; el contrato Soroban también traduce
sus propios errores a estos códigos antes de que cualquier Edge Function los devuelva al cliente
(`research.md` §4). `PA008` (rol no autorizado) se **reutiliza** tal cual para todo rechazo de rol
en esta feature (registrar/asignar solo `operador_banco`) — el código es el mismo, el mensaje
cambia según el endpoint, el cliente sigue decidiendo por código.

| Código | Significado | Origen |
|---|---|---|
| `PA014` | Datos de factura incoherentes (monto ≤ 0, vencimiento ≤ emisión, moneda no soportada) | `registrar_factura`, FR-002 |
| `PA015` | Factura duplicada (mismo proveedor, deudor, monto y fechas) | `registrar_factura`, FR-003 |
| `PA016` | Factura inexistente o no está en estado "aprobada" para asignarse | `asignar_factura_a_pool`, FR-006 |
| `PA017` | Anticipo inválido (≤ 0, o mayor que el valor nominal de la factura) | `asignar_factura_a_pool`, FR-009 |
| `PA018` | La factura ya está asignada a otro pool/tramo (perdió la carrera de asignación) | `asignar_factura_a_pool`, edge case de asignación concurrente |
| `PA019` | Fallo al invocar el contrato Soroban (registro de factura o emisión de fracciones), tras agotar reintentos | `asignar-factura`/`confirmar-aporte`, FR-027, `research.md` §2 |
| `PA020` | El contrato rechazó la operación por cupo on-chain insuficiente (defensa en profundidad; no debería ocurrir si Postgres ya validó cupo) | contrato `pool_fraction_token`, `research.md` §2 |

## Entidades

### `public.proveedores` (nueva)

```sql
create table public.proveedores (
  id uuid primary key default gen_random_uuid (),
  nombre_comercial text not null,
  created_at timestamptz not null default now()
);
```

Empresa ficticia titular de una factura por cobrar (spec: Key Entities → Proveedor). Nunca se
expone su `nombre_comercial` a un inversionista — solo `registrar_factura`/`listar_facturas_
operador` (operador de banco) la leen. RLS habilitada sin políticas, `revoke all` a
`anon`/`authenticated`.

### `public.empresas_pagadoras` (existente, spec previa — reinterpretada como "Deudor")

Sin cambios de esquema. La spec de esta feature adopta el término "Deudor" para el mismo concepto
ya modelado por `empresas_pagadoras` (empresa obligada a pagar la factura) — ver `spec.md` →
Assumptions. No se renombra la tabla (evita tocar cinco referencias ya desplegadas en
`0003_dominio_pools.sql`/`0009_catalogo_consultas.sql`/seed sin beneficio real).

### `public.facturas` (renombrada desde `public.operaciones` — ver `research.md` §7)

```sql
alter table public.operaciones rename to facturas;

alter table public.facturas
  alter column pool_id drop not null,
  add column proveedor_id uuid not null references public.proveedores (id),
  add column fecha_emision date not null default current_date,
  add column fecha_vencimiento date not null default (current_date + interval '30 days'),
  add column huella_hash text not null default '',
  add column estado_validacion public.estado_validacion_factura not null default 'aprobada',
  add column motivo_rechazo text,
  add column estado_cobro public.estado_cobro_factura not null default 'pendiente',
  add column estado_asignacion public.estado_asignacion_factura not null default 'sin_asignar',
  add column tramo_id uuid references public.tramos (id),
  add column anticipo numeric(14, 2),
  add column onchain_tx_hash text,
  add constraint facturas_anticipo_valido check (
    anticipo is null or (anticipo > 0 and anticipo <= monto_nominal)
  ),
  add constraint facturas_asignacion_coherente check (
    (estado_asignacion = 'sin_asignar' and tramo_id is null and pool_id is null and anticipo is null)
    or (estado_asignacion <> 'sin_asignar' and tramo_id is not null and pool_id is not null and anticipo is not null)
  );
```

(Los valores `default` de las columnas nuevas `not null` cubren únicamente las filas de la feature
previa ya sembradas, que nacieron directamente "asignadas" sin pasar por este flujo de originación
— ver seed de esta feature en `quickstart.md` §7 para cómo se les asigna `proveedor_id`/`huella_
hash` reales de forma retroactiva. Toda fila **nueva** de esta feature en adelante siempre pasa por
`registrar_factura`, que fija estos valores explícitamente.)

```sql
create type public.estado_validacion_factura as enum ('aprobada', 'rechazada');
create type public.estado_cobro_factura as enum ('pendiente', 'cobrada', 'en_mora');
create type public.estado_asignacion_factura as enum ('sin_asignar', 'pendiente_onchain', 'asignada', 'rechazada_asignacion');
```

**Ciclo de vida de una factura**:

```
registrar_factura()
   │
   ├─ datos incoherentes/duplicados ──────────────► estado_validacion = 'rechazada' (terminal)
   │
   └─ datos coherentes ─► estado_validacion = 'aprobada', estado_asignacion = 'sin_asignar'
                                  │
                                  │  asignar_factura_a_pool(factura_id, tramo_id, anticipo)
                                  ▼
                          estado_asignacion = 'pendiente_onchain'  (tramo/pool ya actualizados)
                                  │
                    ┌─────────────┴──────────────┐
                    │ contrato: register_invoice │
                    │        éxito                │        fallo (tras reintentos)
                    ▼                              ▼
      confirmar_asignacion_factura()      revertir_asignacion_factura()
                    │                              │
                    ▼                              ▼
      estado_asignacion = 'asignada'    estado_asignacion = 'sin_asignar'
         (terminal, irreversible          (vuelve a 'aprobada' sin pool/tramo/
          — FR-012)                        anticipo; el operador puede reintentar
                                            con otro pool/tramo/anticipo)
```

Una factura en `'asignada'` nunca vuelve a `'sin_asignar'` (FR-012 — irreversible una vez
confirmada). `'pendiente_onchain'` es un estado transitorio que solo existe entre la reserva en
Postgres y la confirmación/reversión del paso on-chain — nunca se expone como resultado final al
operador (mismo principio de "nunca pendiente" que ya rige `aportes`).

**Huella (`huella_hash`)**: `encode(digest(proveedor_id::text || deudor_id::text ||
monto_nominal::text || moneda::text || fecha_emision::text || fecha_vencimiento::text, 'sha256'),
'hex')`, calculada dentro de `registrar_factura` en el momento de la aprobación — nunca depende del
pool ni del anticipo (una factura conserva la misma huella aunque cambie de intento de asignación).
Es lo único de la factura que llega al contrato (FR-016).

### `public.tramos` (existente, spec previa — columnas nuevas)

```sql
alter table public.tramos
  add column monto_financiado_acumulado numeric(14, 2) not null default 0
    check (monto_financiado_acumulado >= 0),
  add column reserva numeric(14, 2) not null default 0 check (reserva >= 0),
  add column fracciones_totales integer not null default 0 check (fracciones_totales >= 0),
  add column token_contract_id text;
```

`capital_objetivo` (ya existente) pasa de valor fijo de creación a **derivado y dinámico**:
invariante `capital_objetivo = fracciones_totales * pools.unidad_minima_aporte`, mantenido por
`asignar_factura_a_pool`/`revertir_asignacion_factura` y reforzado por un trigger de defensa en
profundidad (`tramos_capital_objetivo_multiplo`, rechaza cualquier `UPDATE` que lo deje en un valor
no múltiplo de la unidad mínima del pool). `capital_comprometido` y su invariante existente
(`<= capital_objetivo`) no cambian — `cotizar_aporte`/`reservar_aporte` siguen sin tocarse
(`research.md` §6). `token_contract_id` queda `NULL` hasta que `provision-pool-tramo-token` (nueva
Edge Function) instancia el contrato de ese tramo — mismo ciclo de vida asíncrono que `pools.
custody_public_key`/`perfiles.wallet_public_key`.

### `public.configuracion_red` (nueva)

```sql
create table public.configuracion_red (
  red text primary key,
  operador_authority_public_key text not null,
  operador_authority_secret_id uuid not null,
  token_wasm_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Una sola fila por red (`'testnet'` en este proyecto). La puebla el script de despliegue
(`contracts/scripts/deploy.sh`, ver `contracts/deploy-contrato.md`), nunca una migración ni el
Dashboard — la migración solo crea la tabla vacía. `operador_authority_secret_id` apunta a
`vault.secrets` (mismo patrón sin FK explícita que `pools.custody_secret_id`, spec previa —
`vault` no admite FKs cruzados de forma práctica). Leída por las Edge Functions vía
`obtener_configuracion_red()`/`obtener_secreto_autoridad_operador()` (`service_role` únicamente).

### `public.aportes` (existente, spec previa — columnas nuevas)

```sql
alter table public.aportes add column fraccion_tx_hash text;
alter type public.motivo_reversion_aporte add value 'fallo_emision_fracciones';
```

`fraccion_tx_hash` guarda el hash de la invocación `mint` del contrato — distinto de `tx_hash`
(pago XLM clásico vía Horizon, ya existente). Un aporte `'confirmado'` (FR-017) siempre tiene
ambos hashes no nulos; ninguno de los dos se sobrescribe nunca. `fraccion_tx_hash IS NOT NULL`
antes de invocar el contrato de nuevo es la guarda de idempotencia del mint (`research.md` §2).

**Ciclo de vida extendido de un Aporte** (delta sobre el ya documentado en la spec previa):

```
reservado ──(pago XLM ok)──► [pendiente de mint] ──(mint ok)──► confirmado
    │                              │
    │ (pago XLM falla)             │ (mint falla tras reintentos)
    ▼                              ▼
revertido                  reembolso XLM (custodia→inversionista) ──► revertido
('fallo_red_stellar',              ('fallo_emision_fracciones')
 ya existente)
```

"[pendiente de mint]" no es un valor de `estado` nuevo en la tabla — es un punto intermedio
*dentro de la misma invocación síncrona* de la Edge Function, nunca observable por el cliente como
un estado propio (se resuelve a `confirmado` o `revertido` antes de responder — FR-034 sigue sin
reabrirse).

## Contrato Soroban `pool_fraction_token` — almacenamiento

Ver `contracts/soroban-pool-token.md` para la interfaz completa (funciones, errores, eventos).
Resumen del almacenamiento por instancia (una instancia = un tramo):

| Clave | Tipo | Contenido |
|---|---|---|
| `Admin` | `Address` | Autoridad de plataforma (`configuracion_red.operador_authority_public_key`) |
| `Decimals` | `u32` | Fijo en `0` |
| `Cap` | `i128` | = `tramos.fracciones_totales` (Postgres es quien decide el valor; el contrato solo lo aplica) |
| `TotalSupply` | `i128` | Suma de fracciones ya emitidas a inversionistas |
| `Balance(Address)` | `i128` | Fracciones que posee esa dirección en este tramo |
| `Factura(BytesN<32>)` | `i128` | Incremento de fracciones que aportó esa huella de factura (evidencia, no se usa para cálculos) |

## Cobertura de requisitos (delta sobre la spec previa)

| Requisitos | Cubiertos por |
|---|---|
| FR-001 – FR-005 | `registrar_factura()` — `contracts/registrar-factura.md` |
| FR-006 – FR-012 | `asignar_factura_a_pool()` / `confirmar_asignacion_factura()` / `revertir_asignacion_factura()` — `contracts/asignar-factura-function.md` |
| FR-013 – FR-018 | Contrato `pool_fraction_token` (`register_invoice`, `mint`, `balance`) — `contracts/soroban-pool-token.md` |
| FR-019 – FR-022 | `facturas_del_pool()` — `contracts/facturas-del-pool.md` |
| FR-023 | `pools.margen_plazo_dias` (nueva columna, ver abajo) — `contracts/facturas-del-pool.md` |
| FR-024 – FR-026 | `actualizar_estado_cobro_factura()` (único punto de escritura de `estado_cobro`) + bloque `estado_facturas` agregado a `detalle_pool()`, calculado en vivo — `contracts/facturas-del-pool.md` §Extensión de `detalle_pool` y §`actualizar_estado_cobro_factura` |
| FR-027 | `research.md` §2 (contrato manda + compensación + guarda de idempotencia `fraccion_tx_hash`) |
| FR-028 | Todas las funciones nuevas repiten el patrón `select ... where id = p_x` + `if not found` antes de mutar — ninguna resulta en dos filas para la misma solicitud repetida |
| FR-029 | `PA008` reutilizado en `registrar_factura`, `asignar_factura_a_pool`, `listar_facturas_operador` |
| FR-030 – FR-032 | `quickstart.md` §7 (seed de facturas en varios estados + un pool tokenizado de punta a punta) |

**Columna adicional no listada explícitamente en la spec pero necesaria para FR-024** (margen de
plazo propio del pool):

```sql
alter table public.pools add column margen_plazo_dias integer not null default 5 check (margen_plazo_dias >= 0);
```

Documentado como supuesto razonable (`spec.md` → Assumptions: "el margen de plazo es un parámetro
propio de cada pool, sin un valor fijo global") — `5` es el valor por defecto que usan los pools ya
sembrados; el operador puede fijar otro valor por pool nuevo. Este campo es puramente informativo
(no dispara ninguna validación bloqueante) — `detalle_pool` lo expone para que el cliente pueda
mostrar "vencimiento esperado del pool ± margen" sin que el sistema rechace nada si una factura se
cobra unos días antes o después.
