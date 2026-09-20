# Contrato: `mis_posiciones` (función RPC)

Función `public.mis_posiciones()`, `security definer`, expuesta vía `/rest/v1/rpc/mis_posiciones`.
Cubre Historia 5 (FR-035, FR-036). Restringida a `authenticated`; devuelve exclusivamente las
posiciones del propio `auth.uid()` — no acepta ningún parámetro de identidad, precisamente para
que no exista forma de pedir las posiciones de otro inversionista (FR-036).

## Llamada

```ts
const { data, error } = await supabase.rpc("mis_posiciones");
```

## Respuesta (éxito)

```json
[
  {
    "aporte_id": "uuid",
    "pool_id": "uuid",
    "pool_nombre": "text",
    "pool_estado": "abierto",
    "tramo_tipo": "senior",
    "monto_nominal": 300.00,
    "moneda": "PEN",
    "xlm_pagados": 833.3333333,
    "tipo_cambio_aplicado": 0.36,
    "confirmado_at": "2026-09-20T18:02:11Z"
  }
]
```

- Solo incluye aportes con `estado = 'confirmado'` — uno en `reservado` es un estado transitorio
  interno de la orquestación de `confirmar-aporte` (nunca visible desde fuera de esa función,
  dado que la respuesta de esa Edge Function ya es síncrona) y uno `revertido` nunca fue una
  inversión real.
- Un inversionista sin ningún aporte confirmado recibe `[]`, nunca un error (Historia 5 escenario
  3).
- `pool_estado` se lee en vivo del pool al momento de la consulta (no un snapshot del momento del
  aporte) — así refleja si el pool ya se fondeó o cerró después.

## Errores

Ninguno específico de negocio — solo falta de sesión (`401`, gestionado por Supabase Auth).
