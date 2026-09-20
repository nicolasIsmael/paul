# Contrato: `detalle_pool` (función RPC)

Función `public.detalle_pool(p_pool_id uuid)`, `security definer`, expuesta vía
`/rest/v1/rpc/detalle_pool`. Cubre Historia 2 (FR-013 a FR-019). Accesible a cualquier cuenta
`authenticated`, incluida una cuyo `perfiles.wallet_public_key` todavía sea `NULL` (puede
explorar aunque no pueda aportar — FR-012).

## Llamada

```ts
const { data, error } = await supabase.rpc("detalle_pool", { p_pool_id: "uuid" });
```

## Respuesta (éxito)

```json
{
  "id": "uuid",
  "nombre": "text",
  "descripcion_corta": "text",
  "moneda": "PEN",
  "plazo_dias": 60,
  "fecha_vencimiento_esperada": "2026-11-19",
  "perfil_riesgo": "balanceado",
  "perfil_riesgo_explicacion": "text (1-2 frases)",
  "estado": "abierto",
  "composicion": {
    "numero_operaciones": 14,
    "numero_empresas": 9,
    "sectores": ["retail", "servicios"],
    "concentracion_maxima_pct": 12.5
  },
  "tramos": {
    "senior": {
      "capital_objetivo": 35000.00,
      "capital_comprometido": 22000.00,
      "avance_pct": 62.9,
      "cupo_disponible": 13000.00,
      "rendimiento_ilustrativo_plazo_pct": 3.2,
      "rendimiento_ilustrativo_anualizado_pct": 6.4
    },
    "junior": {
      "capital_objetivo": 15000.00,
      "capital_comprometido": 10500.00,
      "avance_pct": 70.0,
      "cupo_disponible": 4500.00,
      "rendimiento_ilustrativo_plazo_pct": 7.8,
      "rendimiento_ilustrativo_anualizado_pct": 15.6
    }
  },
  "colchon_junior_pct": 30.0,
  "aporte_minimo": {
    "moneda": "PEN",
    "monto": 100.00,
    "equivalente_xlm": 833.3333333,
    "tipo_cambio_disponible": true
  },
  "comparacion_tramos": {
    "senior": "text — qué pasa si una empresa no paga, en lenguaje simple",
    "junior": "text — qué pasa si una empresa no paga, en lenguaje simple"
  },
  "disclaimer_rendimiento": "Rendimiento ilustrativo, sin garantía, en red de pruebas."
}
```

- `aporte_minimo.equivalente_xlm` es `null` y `tipo_cambio_disponible: false` si no hay ninguna
  fila en `tipos_cambio_referencia` para la moneda del pool — **la exploración nunca se bloquea**
  por falta de tipo de cambio, solo la cotización/aporte lo hacen (ver `cotizar-aporte.md`).
- Ningún campo expone una operación o empresa individual — `composicion` es siempre agregado
  (FR-014).

## Errores

| Código | Cuándo |
|---|---|
| `PA012` | `p_pool_id` no corresponde a ningún pool existente |
