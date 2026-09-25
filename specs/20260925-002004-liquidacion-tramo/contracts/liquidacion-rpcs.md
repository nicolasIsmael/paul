# Contrato: RPCs de liquidación de tramo

Todas `SECURITY DEFINER`, mismo patrón que `asignar_factura_a_pool`/`reservar_aporte`. Ninguna es
llamada directamente por el cliente — todas se invocan desde la Edge Function `liquidar-tramo`
(`liquidar-tramo-function.md`) usando `service_role`.

## Registro de códigos de error (continúa desde `PA020`, spec de originación)

| Código | Significado | Origen |
|---|---|---|
| `PA008` | Rol no autorizado (reutilizado tal cual — solo `operador_banco` puede liquidar) | `iniciar_liquidacion_tramo`, FR-002 |
| `PA019` | Fallo al invocar el contrato Soroban (`burn`), tras agotar reintentos (reutilizado tal cual) | `liquidar-tramo`, FR-008 |
| `PA021` | El tramo no está en estado `activo` (ya está `liquidando` o `liquidado`) | `iniciar_liquidacion_tramo`, FR-011 |
| `PA022` | El tramo tiene al menos una factura asignada que no está `cobrada` | `iniciar_liquidacion_tramo`, FR-003 |
| `PA023` | Tramo inexistente | `iniciar_liquidacion_tramo` |

## `iniciar_liquidacion_tramo(p_tramo_id uuid) returns jsonb`

**Entrada**: `p_tramo_id`.

**Procesamiento**:
1. Exige `perfiles.rol = 'operador_banco'` → `PA008`.
2. `select ... from tramos where id = p_tramo_id for update` → si no existe, `PA023`.
3. Si `estado_liquidacion <> 'activo'` → `PA021`.
4. Si existe alguna fila en `facturas` con `tramo_id = p_tramo_id` y `estado_cobro <> 'cobrada'`
   → `PA022`, incluyendo en el mensaje los `id` de las facturas pendientes.
5. `update tramos set estado_liquidacion = 'liquidando' where id = p_tramo_id`.
6. Devuelve la lista de inversionistas a procesar:

   ```sql
   select distinct a.investor_id, p.wallet_public_key
   from aportes a
   join perfiles p on p.id = a.investor_id
   where a.tramo_id = p_tramo_id
     and a.estado = 'confirmado'
     and not exists (
       select 1 from liquidaciones_tramo_inversionista l
       where l.tramo_id = a.tramo_id and l.investor_id = a.investor_id
     )
   ```

**Salida**:

```json
{
  "ok": true,
  "tramo_id": "uuid",
  "inversionistas": [
    { "investor_id": "uuid", "wallet_public_key": "G..." }
  ]
}
```

Si `inversionistas` es una lista vacía (tramo sin aportes confirmados, o ya reanudado y todos
procesados), la Edge Function llama `finalizar_liquidacion_tramo` de inmediato (FR-009).

## `registrar_pago_liquidacion(p_tramo_id uuid, p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_tx_pago text, p_tx_quema text) returns void`

Inserta en `liquidaciones_tramo_inversionista` con `estado = 'pagado'`. `on conflict
(tramo_id, investor_id) do nothing` — protege contra una doble llamada accidental de la Edge
Function para el mismo inversionista (idempotencia, mismo espíritu que `data-model.md` →
reanudación).

## `registrar_liquidacion_compensada(p_tramo_id uuid, p_investor_id uuid, p_fracciones integer, p_monto numeric, p_moneda text, p_motivo text, p_tx_hash_pago text default null, p_tx_hash_quema text default null) returns void`

Inserta con `estado = 'compensado'`. Mismo `on conflict do nothing`.

## `finalizar_liquidacion_tramo(p_tramo_id uuid) returns void`

`update tramos set estado_liquidacion = 'liquidado' where id = p_tramo_id and estado_liquidacion =
'liquidando'`. El filtro por `'liquidando'` evita marcar `'liquidado'` dos veces si la Edge
Function se reintenta después de ya haber terminado.
