# Contrato: `catalogo_pools` (función RPC)

Función `public.catalogo_pools(...)`, `security definer`, expuesta vía
`/rest/v1/rpc/catalogo_pools`. Cubre Historia 1 (FR-009 a FR-012). Accesible a cualquier cuenta
`authenticated` (inversionista **u** operador — la spec no restringe la exploración, solo el
aporte); nunca a `anon`.

## Llamada

```ts
const { data, error } = await supabase.rpc("catalogo_pools", {
  p_moneda: "PEN" | "USD" | null,          // filtro opcional
  p_plazo_dias: 30 | 60 | 90 | null,       // filtro opcional
  p_perfil_riesgo: "conservador" | "balanceado" | "agresivo" | null,
  p_sector: "retail" | "manufactura" | "servicios" | "construccion" | "tecnologia" | null,
  p_estado: "abierto" | "fondeado" | "cerrado" | null,
  p_orden: "avance_desc" | "avance_asc" | "monto_desc" | "monto_asc" | "vencimiento_asc",
});
```

Todos los parámetros son opcionales (`default null`); combinables entre sí (FR-010, filtro
`p_sector` hace `exists` contra las `operaciones` del pool sin exponerlas). `p_orden` por defecto
`avance_desc`.

## Respuesta (éxito)

Un array de filas, una por pool que cumple los filtros:

```json
[
  {
    "id": "uuid",
    "nombre": "text",
    "moneda": "PEN",
    "plazo_dias": 60,
    "perfil_riesgo": "balanceado",
    "estado": "abierto",
    "capital_objetivo": 50000.00,
    "capital_comprometido": 32500.00,
    "avance_pct": 65.0,
    "sectores": ["retail", "servicios"]
  }
]
```

`capital_objetivo`/`capital_comprometido` son la suma de los dos tramos del pool (nunca una
columna denormalizada — ver `data-model.md`). Ningún campo de este contrato identifica una
operación o empresa individual (FR-014).

## Errores

Esta función no tiene casos de rechazo de negocio (una consulta con filtros que no matchean nada
simplemente devuelve un array vacío, nunca un error). Solo puede fallar por falta de sesión
(`401`, gestionado por PostgREST/Supabase Auth, no por esta función).
