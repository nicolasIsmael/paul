# Contrato: `cotizar_aporte` (función RPC)

Función `public.cotizar_aporte(p_pool_id uuid, p_tramo_tipo text, p_monto numeric)`,
`security definer`, expuesta vía `/rest/v1/rpc/cotizar_aporte`. Cubre el primer paso de Historia 4
(FR-020 a FR-023). Restringida a `authenticated` con `perfiles.rol = 'inversionista'` y billetera
ya aprovisionada.

No mueve dinero ni XLM — solo crea una fila en `cotizaciones` que la Edge Function
`confirmar-aporte` (ver `confirmar-aporte-function.md`) consumirá si el inversionista decide
seguir adelante. Puede llamarse tantas veces como se quiera sin efecto secundario más allá de
crear filas de cotización (las no usadas simplemente expiran).

## Llamada

```ts
const { data, error } = await supabase.rpc("cotizar_aporte", {
  p_pool_id: "uuid",
  p_tramo_tipo: "senior" | "junior",
  p_monto: 300.00, // en la moneda del pool
});
```

## Respuesta (éxito)

```json
{
  "cotizacion_id": "uuid",
  "pool_id": "uuid",
  "tramo_tipo": "senior",
  "monto_nominal": 300.00,
  "moneda": "PEN",
  "tipo_cambio_aplicado": 0.36,
  "tipo_cambio_marca_tiempo": "2026-09-20T18:00:00Z",
  "tipo_cambio_nota": "Parámetro de demostración — testnet, sin valor de mercado real",
  "monto_xlm": 833.3333333,
  "expira_at": "2026-09-20T18:05:00Z"
}
```

`tipo_cambio_aplicado` es exactamente la tasa que se aplicará si esta cotización se confirma
dentro de los 5 minutos de validez (`expira_at`) — nunca se recalcula al confirmar (FR-024).

## Errores

| Código | Cuándo |
|---|---|
| `PA008` | Rol no autorizado (operador de banco) |
| `PA007` | Billetera del inversionista todavía se está creando |
| `PA012` | `p_pool_id`/`p_tramo_tipo` no corresponden a un tramo existente |
| `PA006` | El pool no está en estado `abierto` |
| `PA001` | `p_monto` no es múltiplo de `pools.unidad_minima_aporte` |
| `PA002` | Saldo de demostración del inversionista en la moneda del pool, insuficiente para `p_monto` |
| `PA003` | `p_monto` excede el cupo disponible del tramo (el cuerpo del error incluye `cupo_disponible` con el monto exacto que sí cabe) |
| `PA010` | No hay tipo de cambio de referencia disponible para la moneda del pool |

**Nota de diseño**: `cotizar_aporte` valida saldo y cupo con los mismos criterios que
`reservar_aporte` (ver `confirmar-aporte-function.md`) para poder informar el error tan pronto
como sea posible, pero **no** los reserva — la reserva real y atómica ocurre recién al confirmar,
para no bloquear cupo con cotizaciones que el usuario nunca confirma (edge case: "pool que se
llena o se cierra mientras el usuario está por confirmar" se maneja en la reserva, no aquí).
