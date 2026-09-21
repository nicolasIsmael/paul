# Contrato: RPC `registrar_factura`

Función `security definer`, invocada **directamente por el cliente autenticado** vía
`supabase.rpc('registrar_factura', {...})` (sin Edge Function — no toca Stellar ni Vault, igual que
`cotizar_aporte`). Cubre Historia 1 (FR-001 – FR-005).

## Firma

```sql
registrar_factura(
  p_proveedor_nombre text,
  p_deudor_nombre text,
  p_deudor_sector public.sector_empresa,
  p_moneda public.moneda_soportada,
  p_monto_nominal numeric,
  p_fecha_emision date,
  p_fecha_vencimiento date
) returns jsonb
```

## Procesamiento

1. `rol = (select rol from perfiles where id = auth.uid())`; si `rol <> 'operador_banco'` →
   `PA008`.
2. Validaciones de coherencia, en este orden, cada una con su propio código (FR-002):
   - `p_monto_nominal <= 0` → `PA014`.
   - `p_fecha_vencimiento <= p_fecha_emision` → `PA014`.
   - `p_moneda` no soportada → nunca ocurre en la práctica (el tipo `moneda_soportada` ya lo
     restringe a nivel de tipo; PostgREST rechazaría antes un valor fuera del enum) — documentado
     por completitud de la spec, sin código propio.
3. Busca `proveedores`/`empresas_pagadoras` por `nombre_comercial` exacto; si no existen, los crea
   (`insert ... returning id`, primera vez que se menciona ese nombre). No requiere que el operador
   preseleccione un `id` — el flujo de registro trabaja con nombres, como pide la spec.
4. Duplicado (FR-003): existe ya una factura con el mismo `proveedor_id`, `deudor_id`
   (`empresa_id`), `monto_nominal`, `fecha_emision` y `fecha_vencimiento` → `PA015`, no se inserta
   nada.
5. Calcula `huella_hash` (`data-model.md` → Factura).
6. Inserta la factura con `estado_validacion = 'aprobada'` y `estado_asignacion = 'sin_asignar'`.
   No existe un tercer resultado posible — toda factura queda aprobada o rechazada de inmediato
   (FR-004), nunca en revisión.

## Salida

**Aprobada**:

```json
{ "factura_id": "uuid", "estado_validacion": "aprobada", "huella_hash": "ab12...", "monto_nominal": 4500.00 }
```

**Rechazada** (la función no lanza excepción para el caso de datos incoherentes/duplicados — los
devuelve como resultado, no como error HTTP, porque "registrar una factura inválida" es un
resultado de negocio válido, no un fallo de la llamada en sí; distinto de `PA008` — rol incorrecto,
que sí es un error de la llamada):

```json
{ "factura_id": "uuid", "estado_validacion": "rechazada", "motivo_rechazo": "PA014", "detalle": "El monto debe ser positivo." }
```

El cliente decide su UI por `estado_validacion` + `motivo_rechazo` (código), nunca por el texto de
`detalle`.

## RPC de apoyo: `listar_facturas_operador`

```sql
listar_facturas_operador(
  p_estado_validacion public.estado_validacion_factura default null,
  p_estado_asignacion public.estado_asignacion_factura default null
) returns table (
  id uuid, proveedor_nombre text, deudor_nombre text, deudor_sector public.sector_empresa,
  moneda public.moneda_soportada, monto_nominal numeric, fecha_emision date,
  fecha_vencimiento date, estado_validacion public.estado_validacion_factura,
  motivo_rechazo text, estado_asignacion public.estado_asignacion_factura,
  estado_cobro public.estado_cobro_factura, pool_id uuid, tramo_id uuid, anticipo numeric
)
```

No forma parte de un requisito funcional explícito de la spec, pero es indispensable para que
Historia 2 (asignar una factura) sea operable: el operador necesita ver qué facturas aprobadas
existen antes de poder elegir una para asignar. Mismo chequeo de rol (`PA008`) que `registrar_
factura`; es la **única** función de esta feature que expone `proveedor_nombre`/`deudor_nombre`
por fila — reservada exclusivamente a `operador_banco` (FR-021).
