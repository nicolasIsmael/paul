# Guía de integración Frontend — Originación de Facturas y Tokenización de Fracciones

Esta guía es para el Frontend Engineer que va a construir pantallas sobre esta feature. Lista los
escenarios que **ya están implementados, desplegados y validados en vivo contra Supabase +
Stellar testnet** — no hay nada especulativo aquí, todo lo de abajo funciona hoy.

No incluye diseño de UI ni flujos de pantalla — solo qué llamar, con qué datos, qué esperar de
vuelta, y por qué existe cada pieza.

## Antes de empezar

- **Cliente**: `supabase-js`, ya inicializado en el proyecto con `SUPABASE_URL` +
  `SUPABASE_ANON_KEY`. Las funciones RPC se llaman con `supabase.rpc(nombre, params)`; las Edge
  Functions con `supabase.functions.invoke(nombre, { body })` (o `fetch` directo a
  `${SUPABASE_URL}/functions/v1/<nombre>` con el header `Authorization: Bearer <access_token>`).
- **Roles**: cada usuario autenticado tiene `perfiles.rol` = `'operador_banco'` o `'inversionista'`.
  El backend valida el rol en cada función — no hace falta duplicar esa lógica en el frontend, pero
  sí conviene ocultar/mostrar pantallas según el rol de la sesión activa para no exponer botones
  que van a fallar con `PA008`.
- **Errores**: todo error viene como `{ code, message }` (RPC) o `{ ok: false, error: { code,
  message } }` (Edge Functions). El frontend decide por `code`, nunca por el texto de `message`
  (puede cambiar). Tabla completa al final de este documento.
- **Dinero vs. fracciones**: los montos de factura/anticipo son soles o dólares (`numeric`). Las
  fracciones del contrato son **enteros puros** — 1 fracción = 1 unidad mínima del pool
  (`unidad_minima_aporte`, ya visible en `detalle_pool` desde la spec anterior).

---

## 1. Registrar una factura de demostración

**Rol**: `operador_banco`.

### Por qué existe
Antes de que un pool pueda respaldarse en algo, tiene que existir una factura. Esta pantalla es el
punto de entrada de todo el ciclo de originación: sin ella no hay nada que asignar ni fraccionar.
En este producto no se sube ni procesa ningún documento real — el operador tipea los datos de
demostración y el sistema decide al instante si son coherentes.

### Cómo integrarlo
```js
const { data, error } = await supabase.rpc('registrar_factura', {
  p_proveedor_nombre: 'Ferretería El Tornillo',
  p_deudor_nombre: 'Constructora Andina SAC',
  p_deudor_sector: 'construccion', // retail | manufactura | servicios | construccion | tecnologia
  p_moneda: 'PEN', // PEN | USD
  p_monto_nominal: 2500.00,
  p_fecha_emision: '2026-09-01',
  p_fecha_vencimiento: '2026-10-15',
});
```
`data` viene con la factura y su `estado_validacion` (`'aprobada'` o `'rechazada'`) — la validación
es inmediata, no hay estado "pendiente de revisión". Si se rechaza, `data.motivo_rechazo` trae el
código (`PA014` datos incoherentes, `PA015` duplicada exacta) para mostrar el motivo sin adivinar.

Una factura rechazada por datos incoherentes (`PA014`) **no se persiste** — no aparecerá luego en
ningún listado. Solo `PA015` (duplicada) deja un registro con `estado_validacion = 'rechazada'`.

---

## 2. Ver el catálogo propio de facturas (con nombres reales)

**Rol**: `operador_banco`.

### Por qué existe
El operador necesita una vista de trabajo con proveedor/deudor identificables para decidir qué
factura asignar a qué pool. Es la **única** función de toda la plataforma que expone esos nombres
— el inversionista nunca los ve (sección 5).

### Cómo integrarlo
```js
const { data } = await supabase.rpc('listar_facturas_operador', {
  p_estado_validacion: 'aprobada',   // opcional — o null para todas
  p_estado_asignacion: 'sin_asignar', // opcional — sin_asignar | pendiente_onchain | asignada | rechazada_asignacion
});
```
Cada fila trae `proveedor_nombre`, `deudor_nombre`, `deudor_sector`, `moneda`, `monto_nominal`,
fechas, `estado_validacion`, `motivo_rechazo`, `estado_asignacion`, `estado_cobro`, y (si ya está
asignada) `pool_id`/`tramo_id`/`anticipo`. Con esto se arma tanto la bandeja de "por asignar" como
el detalle de una factura ya asignada.

---

## 3. Asignar una factura a un pool, con evidencia on-chain

**Rol**: `operador_banco`.

### Por qué existe
Esta es la acción que conecta una factura de demostración con un pool real: el operador decide el
anticipo, y el sistema calcula cuántas fracciones nuevas genera ese anticipo (según la unidad
mínima del pool) y deja el residuo como reserva — nunca se rechaza una factura por no ser múltiplo
exacto. La asignación queda **registrada en el contrato Soroban del tramo**, no solo en Postgres:
es la evidencia verificable de la que depende todo el argumento de "Real-World Assets" de esta
feature.

### Cómo integrarlo
```js
const { data, error } = await supabase.functions.invoke('asignar-factura', {
  body: {
    factura_id: '...',
    tramo_id: '...',   // el tramo del pool (senior/junior) que la va a respaldar
    anticipo: 2000.00, // <= monto_nominal de la factura
  },
});
```
Respuesta en éxito:
```json
{
  "ok": true,
  "factura": { "id": "...", "estado_asignacion": "asignada", "huella_hash": "..." },
  "tramo_actualizado": { "fracciones_totales": 312, "reserva": 0 },
  "comprobante_onchain": {
    "tx_hash": "f4f276878251d6bd18745263af2d99126d35c852649f19639ceceaa4e82fbe80",
    "red": "stellar-testnet",
    "contrato": "CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO"
  }
}
```
Usa `comprobante_onchain.tx_hash` para armar un link a
`https://stellar.expert/explorer/testnet/tx/<tx_hash>` — es la prueba pública de que la asignación
existe en la cadena, útil tanto en la pantalla del operador como (de forma agregada) en la del
inversionista. La llamada es **idempotente**: repetirla con el mismo `factura_id` sobre una
asignación ya confirmada devuelve el mismo resultado sin duplicar nada (`ya_existia: true`).

Si el tramo elegido todavía no tiene contrato desplegado, o el contrato falla tras reintentos, la
respuesta es `ok: false` con `PA019` — la factura vuelve automáticamente a `sin_asignar`
(reutilizable con otro pool/tramo), nunca queda a medias.

---

## 4. Actualizar el estado de cobro de una factura

**Rol**: `operador_banco`.

### Por qué existe
El plazo y el estado de una factura (pendiente / cobrada / en mora) son **hechos**, no una promesa
de rendimiento — es la forma en que este producto muestra transparencia sin prometer ganancias
(requisito de cumplimiento de la hackatón). Esta función es cómo el operador simula ese avance en
la demo.

### Cómo integrarlo
```js
await supabase.rpc('actualizar_estado_cobro_factura', {
  p_factura_id: '...',
  p_nuevo_estado: 'cobrada', // pendiente | cobrada | en_mora
});
```
El cambio se refleja **de inmediato** en `detalle_pool` (sección 6) sin ninguna acción adicional —
no hace falta refrescar nada del lado del contrato. Solo funciona sobre facturas ya `'asignada'`
(`PA016` si no).

---

## 5. Ver las facturas anonimizadas que respaldan un pool

**Rol**: cualquier autenticado (pensada para `inversionista`).

### Por qué existe
Antes de aportar, el inversionista necesita criterio: plazos, sector, montos, estado de cobro. Pero
**nunca** el nombre del proveedor ni del deudor — es la pieza central de privacidad de esta
feature. Esta función es, literalmente, la única forma en que un cliente puede ver la composición
de un pool a nivel de factura individual.

### Cómo integrarlo
```js
const { data } = await supabase.rpc('facturas_del_pool', { p_pool_id: '...' });
```
Cada fila: `factura_id`, `monto_nominal`, `moneda`, `sector`, `fecha_vencimiento`, `dias_plazo`,
`estado_cobro`. Nunca `proveedor_nombre` ni `deudor_nombre` — ni siquiera están en el `select` de
la función, así que no hay riesgo de que aparezcan por accidente en una respuesta futura.

Combínala con `detalle_pool(p_pool_id)` (ya existente de la spec anterior, ahora extendida) para
los agregados del pool: trae `margen_plazo_dias` y un bloque nuevo `estado_facturas`:
```json
{
  "estado_facturas": {
    "pendientes": 4,
    "cobradas": 2,
    "en_mora": 1,
    "pct_cobrado": 28.57
  }
}
```
Úsalo para una barra de progreso o badges de estado — nunca para calcular ni mostrar un rendimiento
esperado (fuera de alcance a propósito, ver spec.md → Fuera de Alcance).

---

## 6. Aportar a un pool y recibir fracciones verificables on-chain

**Rol**: `inversionista`.

### Por qué existe
Es el cierre del círculo: el aporte de un inversionista (ya existía desde la spec anterior) ahora
termina emitiendo **fracciones reales en el contrato del tramo**, no solo un registro en Postgres.
El contrato es la fuente de verdad — Supabase solo confirma el aporte después de que el contrato ya
emitió las fracciones.

### Cómo integrarlo
Dos pasos, ya conocidos de la spec anterior — **el segundo cambió de comportamiento** (ahora
también hace el mint on-chain, de forma transparente para el frontend):

```js
// 1) Cotizar (sin cambios de contrato/firma respecto a la spec anterior)
const { data: cotizacion } = await supabase.rpc('cotizar_aporte', {
  p_pool_id: '...',
  p_tramo_tipo: 'senior', // senior | junior
  p_monto: 100, // en la moneda del pool
});

// 2) Confirmar — ahora paga en XLM Y emite fracciones antes de responder
const { data, error } = await supabase.functions.invoke('confirmar-aporte', {
  body: {
    cotizacion_id: cotizacion.cotizacion_id,
    idempotency_key: crypto.randomUUID(), // MISMO valor en reintentos del mismo intento de UI
  },
});
```
Respuesta en éxito:
```json
{
  "ok": true,
  "aporte": { "id": "...", "monto_nominal": 100, "confirmado_at": "..." },
  "comprobante": {
    "tx_hash": "bf94488143dadffaf197d0930da0ba6f965821820336e400e2cec4bf8845fc38",
    "fraccion_tx_hash": "126d725275572e8f31716c7a1042e3be82a454f709aa1720bcd43814bfcbc8bb",
    "red": "stellar-testnet",
    "simulado": false
  }
}
```
`comprobante.tx_hash` es el pago en XLM; `comprobante.fraccion_tx_hash` es la emisión de fracciones
en el contrato — ambos enlazables a `stellar.expert/explorer/testnet/tx/<hash>`. Muestra los dos
por separado: son dos transacciones distintas y cada una es evidencia independiente.

Si el contrato falla después de que el pago ya se hizo, la función **reembolsa automáticamente** el
XLM y responde `PA019` — nunca se pierde dinero del inversionista aunque el mint falle. El frontend
solo necesita mostrar el error; no hay ninguna acción de recuperación manual que implementar.

`idempotency_key` **debe reutilizarse** si el usuario reintenta el mismo intento de aporte (p. ej.
tras perder la conexión) — así se evita cobrar/mintear dos veces por un doble clic o un timeout de
red del lado del cliente.

---

## 7. (Opcional) Verificación independiente en testnet

No es una pantalla nueva, es un extra que ya es posible hoy sin backend adicional: cualquier
`tx_hash` o `contract_id` devuelto por las funciones de arriba se puede verificar de forma
**totalmente independiente de la plataforma**, en:
```
https://stellar.expert/explorer/testnet/tx/<tx_hash>
https://stellar.expert/explorer/testnet/contract/<contract_id>
```
Esto es intencional (Principio de evidencia on-chain verificable): sirve como link de "ver prueba"
en cualquier pantalla que muestre un comprobante, sin depender de que nuestro backend esté vivo
para validarlo.

---

## Códigos de error relevantes en esta feature

| Código | Significa | Dónde puede aparecer |
|---|---|---|
| `PA008` | Rol no autorizado (falta sesión, o rol incorrecto para la acción) | Todas las funciones de operador/inversionista |
| `PA012` | Cuerpo de la solicitud inválido (faltan campos obligatorios) | Edge Functions |
| `PA014` | Datos de factura incoherentes (monto ≤ 0, fechas invertidas, moneda no soportada) | `registrar_factura` |
| `PA015` | Factura duplicada exacta | `registrar_factura` |
| `PA016` | Factura inexistente o no está `'aprobada'` | `asignar_factura_a_pool`, `actualizar_estado_cobro_factura` |
| `PA017` | Anticipo inválido (≤ 0 o mayor al monto nominal) | `asignar-factura` |
| `PA018` | La factura ya está asignada a otro pool/tramo | `asignar-factura` |
| `PA019` | Falló la invocación al contrato tras reintentos (registro de factura o emisión de fracciones) | `asignar-factura`, `confirmar-aporte` |

## Lo que todavía no existe (para no asumirlo)

- No hay pantalla ni endpoint para "desasignar" una factura una vez confirmada — es irreversible
  por diseño (ver spec.md).
- No hay cálculo ni campo de rendimiento/retorno en ningún lado — es intencional, no un olvido.
- No hay mercado secundario de fracciones (no hay `transfer` expuesto al usuario final, aunque el
  contrato lo soporta a nivel de interfaz).
