# Guía de integración para frontend: Pools y primer aporte

Manual práctico de qué ya puede hacer el backend y cómo consumirlo, para quien construya las
pantallas de exploración de pools, saldo y aporte de la app del inversionista. Todo lo descrito
aquí está **desplegado en producción y validado en vivo** (migraciones aplicadas, Edge Functions
desplegadas, seed de datos cargado, y un aporte real confirmado en Stellar testnet verificado
independientemente en Horizon). Como la feature previa, **es exclusivamente backend** — se consume
igual, con `@supabase/supabase-js` contra PostgREST (`supabase.rpc(...)`) más una única llamada
HTTP directa a una Edge Function para confirmar el aporte. Los contratos formales están en
[contracts/](./contracts/); esta guía es la versión "cómo lo uso".

## 0. Antes de esto: requiere sesión y wallet

Esta feature asume ya integrado
[el manual de auth/perfil](../20260919-131233-auth-perfil-usuario/frontend-integration.md):
sesión activa (`supabase.auth.*`) y, para **aportar** (no para explorar), una wallet ya
aprovisionada (`perfiles.wallet_public_key IS NOT NULL`). Explorar pools y ver el detalle **no**
requiere wallet lista — solo sesión. Cotizar y confirmar un aporte sí la requiere.

- **Explorar (catálogo/detalle)**: cualquier cuenta `authenticated`, inversionista u operador.
- **Saldo, recarga, cotizar, aportar, posiciones**: solo `rol = 'inversionista'`; operador recibe
  `PA008`.

## 1. Todo en soles/dólares primero, XLM solo como equivalente

Principio de diseño que atraviesa toda esta feature: el inversionista objetivo piensa en soles y
dólares, no en XLM. **Todo monto que muestres en la moneda del pool debe traer su equivalente en
XLM al lado (o viceversa), nunca uno sin el otro.** El tipo de cambio es un parámetro de
demostración (testnet, sin valor de mercado real) — si en algún punto muestras la tasa o el
equivalente en XLM, acompáñalo del texto que ya trae la propia respuesta
(`tipo_cambio_nota`/`disclaimer_rendimiento`), no lo omitas ni lo reemplaces por texto propio.

## 2. Explorar y comparar pools

```ts
const { data: pools, error } = await supabase.rpc("catalogo_pools", {
  p_moneda: "PEN",              // o "USD" — omite/usa null para no filtrar
  p_plazo_dias: null,           // 30 | 60 | 90 | null
  p_perfil_riesgo: null,        // "conservador" | "balanceado" | "agresivo" | null
  p_sector: null,                // "retail" | "manufactura" | "servicios" | "construccion" | "tecnologia" | null
  p_estado: null,                // "abierto" | "fondeado" | "cerrado" | null
  p_orden: "avance_desc",        // "avance_desc" | "avance_asc" | "monto_desc" | "monto_asc" | "vencimiento_asc"
});
```

Todos los filtros son opcionales y combinables. Sin resultados → array vacío, nunca error. Cada
fila trae lo esencial para una tarjeta de listado (`nombre`, `moneda`, `plazo_dias`,
`perfil_riesgo`, `estado`, `capital_objetivo`/`capital_comprometido`/`avance_pct`, `sectores`).
Nunca expone una operación o empresa individual — eso es intencional (FR-014), no un dato
faltante.

Para el detalle de un pool (pantalla de decisión, antes de aportar):

```ts
const { data: detalle } = await supabase.rpc("detalle_pool", { p_pool_id: pools[0].id });
```

Trae todo lo necesario para decidir sin conocimientos financieros:
`composicion` (agregada, nunca operaciones/empresas individuales),
`tramos.senior`/`tramos.junior` con cupo disponible y rendimiento ilustrativo (a plazo y
anualizado), `colchon_junior_pct`, `comparacion_tramos.senior`/`.junior` (texto ya redactado en
lenguaje simple sobre "qué pasa si una empresa no paga" — úsalo tal cual, no lo reescribas), y
`aporte_minimo` con su equivalente en XLM. Si `aporte_minimo.tipo_cambio_disponible === false`,
`equivalente_xlm` es `null` — muestra el monto en la moneda del pool igual, solo omite el
equivalente XLM (la exploración nunca se bloquea por falta de tipo de cambio).

Único error posible: `PA012` si `p_pool_id` no existe.

## 3. Saldo de demostración y recarga

```ts
const { data: saldo } = await supabase.rpc("mi_saldo_demostracion");
// [{ moneda: "PEN", saldo: 350.00 }, { moneda: "USD", saldo: 0.00 }]
```

Nunca trae equivalente en XLM (el saldo de demostración es puramente contable, no está
denominado en XLM — muéstralo tal cual, en soles/dólares).

```ts
const { data: r, error } = await supabase.rpc("recargar_saldo_demo", { p_moneda: "PEN", p_monto: 200 });
// { saldo_actualizado, moneda, recargado_hoy_equivalente_soles, tope_diario_equivalente_soles,
//   disponible_para_recargar_hoy, se_reinicia_at }
```

- Tope: **S/1000 (o equivalente) por día natural en hora de Lima**, compartido entre soles y
  dólares. Usa `disponible_para_recargar_hoy` para deshabilitar/limitar el input antes de
  intentar la llamada, y muestra `se_reinicia_at` si el usuario pregunta cuándo puede recargar de
  nuevo.
- La recarga **no mueve XLM en la red** — es un crédito contable de demostración. Rotúlalo así en
  la UI (no es dinero real ni promesa de valor — restricción explícita de la spec).
- `PA011` si excede el tope (el error trae `disponible_para_recargar_hoy` y `se_reinicia_at` para
  no necesitar una segunda llamada). `PA007` si la wallet aún no terminó de aprovisionarse (mismo
  estado de "preparando tu wallet..." que ya manejas del flujo de registro). `PA010` si se recarga
  en USD y no hay tipo de cambio disponible para convertir al tope compartido.

## 4. Cotizar y confirmar un aporte (el flujo central)

Dos pasos separados a propósito: cotizar no mueve nada (puedes llamarlo tantas veces como
cambie el monto en el formulario); confirmar sí, y es real.

```ts
const { data: cot, error } = await supabase.rpc("cotizar_aporte", {
  p_pool_id: detalle.id,
  p_tramo_tipo: "senior", // o "junior"
  p_monto: 300,           // en la moneda del pool, múltiplo de la unidad mínima
});
// { cotizacion_id, monto_nominal, moneda, tipo_cambio_aplicado, tipo_cambio_nota,
//   monto_xlm, expira_at }
```

Muestra `monto_xlm` junto al monto en soles/dólares, y una cuenta regresiva hasta `expira_at`
(**5 minutos** de validez). Si expira antes de confirmar, vuelve a llamar `cotizar_aporte` para
una cotización nueva — nunca reutilices un `cotizacion_id` vencido.

Con la cotización en mano, confirmar es la **única** llamada de esta feature que no es
`supabase.rpc(...)` sino un `fetch` directo a la Edge Function (necesita orquestar Stellar, no
solo leer/escribir Postgres):

```ts
const idempotencyKey = crypto.randomUUID(); // genera UNO por intento de "confirmar" en la UI,
                                              // reutilízalo tal cual en cualquier reintento/doble clic
const resp = await fetch(`${SUPABASE_URL}/functions/v1/confirmar-aporte`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ cotizacion_id: cot.cotizacion_id, idempotency_key: idempotencyKey }),
});
const resultado = await resp.json();
```

- **La respuesta de este `fetch` ES el resultado final** — nunca queda "pendiente" ni hay que
  hacer polling después (a diferencia del aprovisionamiento de wallet). Espera la respuesta con un
  loading de unos segundos (hay una llamada real a Stellar testnet de por medio) y muestra
  éxito/error directo de lo que devuelve.
- **Éxito**: `resultado.ok === true`, con `resultado.aporte` (datos de la posición recién creada)
  y `resultado.comprobante.tx_hash` (hash real en Stellar testnet — puedes armar un link a
  `https://stellar.expert/explorer/testnet/tx/<tx_hash>` como comprobante verificable). Si
  `resultado.comprobante.simulado === true`, `tx_hash` es `null` — en ese caso rotula el
  comprobante como **simulado**, nunca lo presentes como evidencia real (no debería ocurrir en el
  estado actual del backend, pero el contrato lo contempla).
- **Doble clic / reintento**: si el usuario toca "confirmar" dos veces o el `fetch` se reintenta
  solo (mala red), vuelve a mandar el **mismo** `idempotency_key` — la respuesta es idéntica
  (mismo `aporte.id`), nunca se duplica el aporte ni se descuenta el saldo dos veces.
- **Error**: `resultado.ok === false`, `resultado.error.code` es el código estable a usar en el
  `switch` de tu UI (ver tabla de la sección 6) — no parsees `resultado.error.message`.

Tras confirmar, si quieres reflejar el avance del pool sin esperar a que el usuario vuelva a la
lista, vuelve a pedir `detalle_pool` del mismo pool: `capital_comprometido` ya viene actualizado.

## 5. Mis posiciones

```ts
const { data: posiciones } = await supabase.rpc("mis_posiciones");
```

Array de aportes **confirmados** del propio usuario (nunca de otro — no acepta ningún parámetro de
identidad). Sin aportes → `[]`, nunca error. Cada fila trae `pool_nombre`, `pool_estado` (leído en
vivo, no un snapshot del momento del aporte), `tramo_tipo`, `monto_nominal`, `moneda`,
`xlm_pagados`, `tipo_cambio_aplicado`, `confirmado_at` — suficiente para una lista sin otra
llamada adicional.

## 6. Códigos de error — usa `error.code`, no el texto

Tanto los `error` de `supabase.rpc(...)` (PostgREST los expone en `error.code`/`error.details` —
`details` trae JSON extra cuando aplica, como `cupo_disponible`) como el `resultado.error.code` de
la Edge Function usan el mismo registro:

| Código | Cuándo | Qué mostrar |
|---|---|---|
| `PA001` | Monto no es múltiplo de la unidad mínima del pool | "El monto debe ser múltiplo de S/X" (unidad en `details`) |
| `PA002` | Saldo de demostración insuficiente | "Te falta saldo — recarga primero" |
| `PA003` | Monto excede el cupo disponible del tramo | Mostrar `cupo_disponible` exacto (viene en el error) y sugerir ese monto |
| `PA004` | Cotización expirada (>5 min) | Pedir una cotización nueva automáticamente |
| `PA005` | Cotización ya usada o de otro inversionista | Pedir una cotización nueva |
| `PA006` | El pool/tramo ya no está "abierto" (se llenó o cerró mientras decidías) | Volver al detalle actualizado del pool |
| `PA007` | La wallet del inversionista aún se está creando | Mismo estado de "preparando tu wallet..." de la sección 5 del manual de auth |
| `PA008` | Cuenta operador de banco (no puede aportar) | No debería llegar aquí si la navegación ya separa por rol — tratar como error genérico |
| `PA009` | XLM insuficiente en la wallet (pago + 2 XLM de reserva mínima) | Caso raro con las wallets demo ya fondeadas; mostrar error genérico de red |
| `PA010` | No hay tipo de cambio de referencia disponible | "Tipo de cambio no disponible, intenta más tarde" |
| `PA011` | Tope diario de recarga excedido | Ver sección 3 |
| `PA012` | Pool/tramo inexistente | Volver al catálogo |
| `PA013` | Fallo de red al someter el pago a Stellar testnet | "Intenta de nuevo" — pedir cotización nueva, reutilizar el mismo `idempotency_key` si el reintento es del mismo intento de usuario |

## 7. Cuentas y pools para probar ya mismo

Las credenciales de las 3 cuentas demo de inversionista están en el `README.md` del repo — ya
tienen saldo, wallet real fondeada, y `inversionista.demo1` además una posición previa (para
probar "mis posiciones" sin aportar primero). El catálogo trae ≥5 pools ficticios ya cargados en
producción cubriendo distintos plazos/monedas/riesgos/sectores y estados de avance variados —
incluye a propósito uno **ya fondeado al 100%** (para probar que `PA006` se muestra bien) y otros
con cupo disponible real (para probar el flujo de aporte completo).

## 8. Checklist rápido

- [ ] Explorar (catálogo/detalle) no exige wallet lista; cotizar/aportar sí.
- [ ] Todo monto en soles/dólares con su equivalente en XLM al lado, nunca uno solo.
- [ ] `cotizar_aporte` se puede llamar libremente (no mueve nada); `confirmar-aporte` es la única
      llamada que sí mueve dinero — nunca la dispares automáticamente, solo tras confirmación
      explícita del usuario.
- [ ] Un `idempotency_key` por intento de confirmación en la UI, reutilizado tal cual en
      reintentos/doble clic — nunca generar uno nuevo en un reintento del mismo intento.
- [ ] `resultado` de `confirmar-aporte` es el resultado final — no hacer polling después.
- [ ] Errores por `error.code`/`resultado.error.code`, nunca por el texto del mensaje.
- [ ] `PA006` (pool ya no admite aportes) es un caso esperado del negocio, no un bug — refrescar el
      detalle del pool y mostrarlo con normalidad.
- [ ] Nunca mostrar un `comprobante.tx_hash` con `simulado: true` como si fuera evidencia real.

## Referencias

- [contracts/](./contracts/) — contrato formal de cada función/endpoint (`catalogo-pools.md`,
  `detalle-pool.md`, `saldo-demostracion.md`, `cotizar-aporte.md`,
  `confirmar-aporte-function.md`, `mis-posiciones.md`)
- [data-model.md](./data-model.md) — entidades, campos y registro completo de códigos de error
- [quickstart.md](./quickstart.md) — misma validación que ya corrió el backend (incluida contra
  producción), útil como referencia de qué comportamiento es "correcto" si algo no coincide
- Manual de la feature previa (requisito para esta):
  [auth-perfil-usuario/frontend-integration.md](../20260919-131233-auth-perfil-usuario/frontend-integration.md)
