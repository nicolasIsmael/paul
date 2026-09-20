# Quickstart: Validar Pools y Primer Aporte (backend, sin UI)

Guía manual de validación (sin tests automatizados, Principio I de la constitución), igual que
`specs/20260919-131233-auth-perfil-usuario/quickstart.md`. Primero **siempre local con Docker**;
solo al final, y con confirmación explícita, se toca el proyecto remoto vinculado
(`qqpozotcrxfukkwcoget`), que ya tiene cuentas demo y billeteras reales.

## 0. Prerrequisitos

- Docker Desktop corriendo (Windows: `host.docker.internal` debe resolver — ver `research.md`
  §2).
- `supabase` CLI (ya en `package.json`).
- Un script de prueba local con `@supabase/supabase-js` apuntando a las credenciales que
  imprime `supabase status` tras `supabase start` (`API URL`, `anon key`, `service_role key`).

## 1. Levantar local y aplicar todo desde cero

```sh
supabase start
supabase db reset            # SOLO local: reaplica todas las migraciones + supabase/seed/*.sql
```

**Qué valida este paso**:
- Las migraciones de esta feature (`0003_dominio_pools.sql` … `0009_catalogo_consultas.sql`, ver
  `plan.md`) aplican sin error sobre una base limpia, junto con las de la feature previa
  (`0001`/`0002`).
- `supabase/seed/00_auth_demo_local.sql` recrea las 4 cuentas demo (3 inversionistas + 1
  operador) — mismas credenciales que documenta el `README.md`.
- `supabase/seed/01_dominio_demo.sql` inserta ≥5 pools ficticios (mayoría en soles, ≥1 en
  dólares), con sus tramos, empresas y operaciones, y el tipo de cambio inicial.
- `supabase/seed/02_saldos_y_posiciones_demo.sql` da saldo de demostración a las 3 cuentas demo de
  inversionista y crea al menos una posición previa entre ellas.

**Confirmar que el webhook de aprovisionamiento corre en local, no en producción** (research.md
§2): tras `db reset`, esperar ~10s y consultar

```sql
select id, codigo, custody_public_key is not null as custodia_lista from public.pools;
select id, es_cuenta_demo, wallet_public_key is not null as wallet_lista from public.perfiles;
```

**Esperado**: todas las filas terminan con `custodia_lista`/`wallet_lista = true` en segundos, sin
tocar el proyecto remoto. Verificar con `supabase functions logs provision-investor-wallet` y
`supabase functions logs provision-pool-custody` que las invocaciones llegaron al runtime local
(`http://host.docker.internal:54321/...`), no a `qqpozotcrxfukkwcoget.supabase.co`.

## 2. Explorar pools (Historia 1 y 2, sin necesitar sesión de inversionista específica)

```ts
const { data: pools } = await supabase.rpc("catalogo_pools", { p_moneda: "PEN" });
const { data: detalle } = await supabase.rpc("detalle_pool", { p_pool_id: pools[0].id });
```

**Esperado**: `pools` trae ≥1 fila en soles con `avance_pct` coherente; `detalle` incluye
`composicion`, `tramos.senior`/`tramos.junior` con cupo disponible, `colchon_junior_pct`, y
`comparacion_tramos` en lenguaje simple. Ningún campo identifica una empresa u operación
individual (confirmar inspeccionando el JSON completo).

## 3. Saldo y recarga (Historia 3) — usar `inversionista.demo1@paul.test`

```ts
await supabase.auth.signInWithPassword({ email: "inversionista.demo1@paul.test", password: "DemoStellar2026!" });
const { data: saldoInicial } = await supabase.rpc("mi_saldo_demostracion");
const { data: r1 } = await supabase.rpc("recargar_saldo_demo", { p_moneda: "PEN", p_monto: 400 });
```

**Esperado**: `r1.saldo_actualizado` = saldo previo + 400; `r1.disponible_para_recargar_hoy` baja
en 400. Repetir la recarga hasta superar S/1000 acumulados el mismo día: la que exceda el tope
**Esperado**: falla con `PA011`, y el cuerpo del error indica cuánto queda disponible (debe ser
`0` o el remanente exacto) y `se_reinicia_at` (00:00 hora de Lima del día siguiente).

**Prueba de concurrencia del tope (SC-008)** — 5 recargas de S/300 en paralelo (`Promise.all`)
sobre la misma cuenta, arrancando con saldo recargado hoy en 0: **Esperado**: como máximo 3 se
aceptan (S/900 ≤ S/1000, la 4ª ya excede), el resto falla con `PA011`; la suma de las aceptadas
nunca supera S/1000 exactos, ni siquiera con las 5 llegando al mismo tiempo.

## 4. Cotizar y confirmar un aporte (Historia 4, el flujo central)

```ts
const { data: cot } = await supabase.rpc("cotizar_aporte", {
  p_pool_id: pools[0].id, p_tramo_tipo: "senior", p_monto: 100,
});

const resp = await fetch(`${SUPABASE_URL}/functions/v1/confirmar-aporte`, {
  method: "POST",
  headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ cotizacion_id: cot.cotizacion_id, idempotency_key: crypto.randomUUID() }),
});
const resultado = await resp.json();
```

**Esperado**: `resultado.ok === true`, `resultado.comprobante.tx_hash` es un hash de 64 caracteres
hex (o `simulado: true` si el mecanismo real todavía no está desplegado), y `detalle_pool` del
mismo pool, consultado de nuevo, muestra `tramos.senior.capital_comprometido` incrementado en 100
y `cupo_disponible` reducido en 100. Verificar el pago en Horizon testnet
(`GET https://horizon-testnet.stellar.org/accounts/{custody_public_key}/payments`) — evidencia
on-chain real (Principio VI de la constitución).

**Doble envío / reintento** (Historia 4 escenario 8): repetir el `fetch` anterior con el
**mismo** `idempotency_key`. **Esperado**: `resultado.ok === true` de nuevo, mismo `aporte.id`,
sin que `capital_comprometido` del tramo se mueva una segunda vez.

**Casos límite a probar explícitamente** (uno por uno, cada uno con una cotización nueva salvo que
se indique lo contrario):
- Monto no múltiplo de la unidad mínima → `cotizar_aporte` falla con `PA001`.
- Monto mayor al saldo de demostración disponible → `PA002`.
- Monto mayor al cupo disponible del tramo → `PA003`, con `cupo_disponible` exacto en el error.
- Confirmar una cotización tras esperar >5 minutos → `PA004`.
- Confirmar la misma cotización dos veces con `idempotency_key` **distintos** → la segunda falla
  con `PA005` (cotización ya usada).
- Con la sesión de `operador.demo@paul.test`: `cotizar_aporte` y `confirmar-aporte` fallan con
  `PA008`.
- Con una cuenta recién registrada cuya wallet aún no terminó de aprovisionarse (registrar una
  nueva mientras se observa `perfiles.wallet_public_key IS NULL`): `cotizar_aporte` falla con
  `PA007`; `catalogo_pools`/`detalle_pool` siguen funcionando igual.

## 5. 20 aportes simultáneos al mismo cupo (SC-002, el criterio de éxito más importante)

Elegir un tramo con cupo disponible pequeño y conocido (por ejemplo, sembrar/ajustar uno a
exactamente 1000 en cupo, con unidad mínima 100 → caben como máximo 10 aportes de 100). Con las 3
cuentas demo de inversionista (y, si hace falta, cuentas adicionales de prueba), generar 20
cotizaciones de 100 sobre ese tramo y confirmarlas todas con `Promise.all` casi al mismo tiempo.

```ts
const resultados = await Promise.all(
  cotizaciones.map((c) => confirmarAporte(c.cotizacion_id, crypto.randomUUID())),
);
const exitosos = resultados.filter((r) => r.ok).length;
```

**Esperado**: `exitosos === 10` exactamente (nunca 11, nunca menos de 10 si todas las cotizaciones
seguían vigentes); las 10 que fallan lo hacen con `PA003`. Verificar
`tramos.capital_comprometido === tramos.capital_objetivo` tras la prueba — nunca lo supera
(SC-002), y `SC-003` (el total de aportes confirmados del pool coincide con su avance de fondeo):

```sql
select sum(monto_nominal) from public.aportes where tramo_id = '<id>' and estado = 'confirmado';
-- debe ser exactamente igual a tramos.capital_comprometido
```

## 6. Mis posiciones (Historia 5)

```ts
const { data: posiciones } = await supabase.rpc("mis_posiciones");
```

**Esperado**: incluye el aporte confirmado en el paso 4 y la posición previa del seed, con pool,
tramo, monto, XLM pagados, tipo de cambio y estado del pool. Repetir con
`inversionista.demo2@paul.test`: **Esperado**: no ve ninguna posición del demo1 (FR-036).

## 7. Aplicar al proyecto remoto (solo tras validar todo lo anterior en local)

**Nunca** `supabase db reset --linked` ni `--include-seed` contra el proyecto vinculado — borra o
reescribe datos reales (cuentas demo, billeteras y posiciones ya existentes en producción).

1. Migraciones (seguro, no toca datos existentes, solo objetos de esquema/función nuevos o
   `CREATE OR REPLACE`):
   ```sh
   supabase db push
   ```
2. Datos de ejemplo (manual, vía conexión directa — **no** `db reset`):
   ```sh
   psql "$DATABASE_URL_REMOTA" -f supabase/seed/01_dominio_demo.sql
   psql "$DATABASE_URL_REMOTA" -f supabase/seed/02_saldos_y_posiciones_demo.sql
   ```
   `supabase/seed/00_auth_demo_local.sql` **no se ejecuta contra remoto** — las 3 cuentas demo de
   inversionista y la de operador ya existen ahí de verdad (creadas por la feature previa), con
   sus billeteras reales; `01_dominio_demo.sql`/`02_saldos_y_posiciones_demo.sql` solo referencian
   esos mismos `id` fijos vía FK, sin volver a crearlos.
3. Repetir la Sección 2 (explorar) y la Sección 4 (un aporte) directamente contra el proyecto
   remoto para confirmar el flujo de punta a punta con datos reales, antes de la demo.

## Referencias

- Modelo de datos, estados y registro de códigos de error: [data-model.md](./data-model.md)
- Contratos consumidos: [contracts/](./contracts/)
- Decisiones técnicas y hallazgos verificados en vivo: [research.md](./research.md)
- Contratos de la feature previa que este flujo asume ya construidos: `perfiles`, wallet de
  inversionista — `specs/20260919-131233-auth-perfil-usuario/contracts/`.
