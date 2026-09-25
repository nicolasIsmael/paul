# Quickstart: Liquidación de Tramo (Cobro Simulado, Camino Feliz)

Validación manual de extremo a extremo (Principio I — sin tests automatizados nuevos; el contrato
Soroban no se toca en esta feature, así que ni siquiera aplica `cargo test`). Mismo flujo de
trabajo que las specs previas: `supabase start` local primero, `supabase db push` a remoto después
de validar, nunca `db reset --linked` contra el proyecto remoto.

## 0. Prerrequisitos

- Migración `0018_liquidacion_tramo.sql` y Edge Function `liquidar-tramo` desplegadas.
- Un tramo real con **al menos un aporte confirmado** y con **fracciones reales verificadas
  on-chain** — usar **Manufactura Sur, tramo senior** (contrato
  `CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO`), el único pool que hoy tokeniza sin
  necesitar ninguna corrección previa (`specs/20260920-174938-originacion-facturas-pool/
  research.md` §9).
- Antes de liquidar, marcar como `cobrada` cada factura asignada a ese tramo con
  `actualizar_estado_cobro_factura` (función ya existente, FR-023 de la spec previa) — sin este
  paso, `iniciar_liquidacion_tramo` debe rechazar la operación (paso 2 de abajo).

## 1. Rechazo si falta cobrar una factura (Historia 2)

Con al menos una factura del tramo todavía en `estado_cobro <> 'cobrada'`:

```http
POST /functions/v1/liquidar-tramo
Authorization: Bearer <jwt operador>
{ "tramo_id": "<id del tramo senior de Manufactura Sur>" }
```

**Esperado**: `ok: false`, `error.code = 'PA022'`, listando el/los `id` de la(s) factura(s) que
faltan. Confirmar que `tramos.estado_liquidacion` **no** cambió (sigue `'activo'`) y que no se
generó ninguna fila en `liquidaciones_tramo_inversionista`.

## 2. Rechazo por rol incorrecto

Con el JWT de una cuenta `inversionista`, repetir la solicitud del paso 1 →
`error.code = 'PA008'`.

## 3. Liquidar el tramo con inversionistas reales (Historia 1)

Marcar como `cobrada` todas las facturas del tramo (paso 0), luego:

```http
POST /functions/v1/liquidar-tramo
Authorization: Bearer <jwt operador>
{ "tramo_id": "<id del tramo senior de Manufactura Sur>" }
```

**Esperado**: `ok: true`, `estado_liquidacion: "liquidado"`, y un objeto en `resultados` por cada
inversionista con aporte confirmado en ese tramo, cada uno con `estado: "pagado"` y sus dos
`tx_hash`.

**Verificación independiente (no confiar solo en la respuesta de la Edge Function)**:

```bash
stellar contract invoke --id CCGH3FI2775BI2KPA5HDTTRBSTSACE2X2H4ZJJ56NWGUBWQ2NWFGQBWO \
  --source-account <cualquier-cuenta> --network testnet -- \
  balance --id <wallet_public_key del inversionista>
```

Debe devolver `0` (sus fracciones se quemaron). Confirmar también en el explorador de Stellar
(usando `tx_hash_pago`) que la wallet del inversionista recibió el XLM real.

Repetir la solicitud del paso 3 una segunda vez → debe volver a fallar con `PA021` (el tramo ya está
`'liquidado'`, estado terminal).

## 4. Liquidar un tramo sin aportes (Historia 3)

Elegir un tramo sembrado sin ningún aporte confirmado (ej. Servicios Lima, cualquiera de sus dos
tramos) y, si tiene facturas asignadas, marcarlas todas como `cobrada` primero (si no tiene
ninguna, se salta este paso — FR-003 no aplica a un tramo sin facturas).

```http
POST /functions/v1/liquidar-tramo
Authorization: Bearer <jwt operador>
{ "tramo_id": "<id de un tramo sin aportes>" }
```

**Esperado**: `ok: true`, `estado_liquidacion: "liquidado"`, `resultados: []` — sin error, sin
ningún pago.

## 5. Fallo forzado de un inversionista particular (Edge Case, FR-008)

Con un tramo que tenga **2 o más** inversionistas con aportes confirmados: antes de liquidar,
dejar sin fondos de red la wallet de custodia del pool (o interrumpir la conexión a Soroban RPC
justo para uno de los inversionistas, si el entorno de prueba lo permite) de forma que la quema de
**uno solo** de ellos falle tras los 3 reintentos.

**Esperado**: la respuesta sigue siendo `ok: true` con `estado_liquidacion: "liquidado"`; el
inversionista afectado aparece en `resultados` con `estado: "compensado"` y un `motivo`; el/los
demás inversionistas del mismo tramo aparecen `"pagado"` con normalidad — confirma SC-003 (un fallo
individual no bloquea al resto del tramo).

## 6. Reanudación segura tras una interrupción

Simular una caída de la Edge Function a mitad de una liquidación con 3+ inversionistas (ej.
cortando la ejecución manualmente después del primer inversionista procesado). Volver a invocar
`liquidar-tramo` con el mismo `tramo_id`.

**Esperado**: el inversionista ya procesado **no** se vuelve a pagar ni a quemar (no aparece de
nuevo en `iniciar_liquidacion_tramo`, gracias al `not exists` sobre
`liquidaciones_tramo_inversionista`); el resto se procesa normalmente y el tramo termina
`'liquidado'`.
