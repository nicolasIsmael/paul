# Quickstart: validación de punta a punta

Guía de validación manual (Principio I: sin suite automatizada).
Cada escenario indica qué comprobar y dónde ver la evidencia. Contratos de cada pieza en
[contracts/](./contracts/); modelo en [data-model.md](./data-model.md).

## 0. Prerrequisitos y versionado (petición explícita)

- Proyecto Supabase `qqpozotcrxfukkwcoget` con las migraciones `0001`–`0019` ya aplicadas (las
  `0018`/`0019` son de la spec `liquidacion-tramo`); `jq`, `curl`; variables `SUPABASE_URL` y
  `SUPABASE_SERVICE_ROLE_KEY` (nunca la anon key) en el entorno.
- Perfiles de demo: 1 operador de banco y ≥ 2 inversionistas con wallet aprovisionada y XLM
  (recarga previa), y ≥ 1 pool con facturas asignadas y aportes confirmados (seed `04`).
- **Regla de versionado**: nada se aplica sin su archivo en el repo.
  1. `supabase db push` (o MCP `apply_migration` leyendo el `.sql` del repo) para `0020`–`0023`.
  2. `supabase functions deploy cobrar-factura marcar-factura-mora repartir-tramo`.
  3. Cargar `supabase/seed/04_cobro_reparto_demo.sql` con `psql`/CLI (idempotente).
  4. **Comprobación**: `git status` no debe mostrar cambios pendientes en `supabase/` ni
     `contracts/` que no estén commiteados; `list_migrations` (MCP) debe mostrar `0020`–`0023`.

## 1. Exclusión mutua con `liquidacion-tramo` (antes de tocar nada)

En un tramo T con aportes: ejecutar el reparto (§4) → `tramos.reparto_estado = 'cerrado'`; luego
`POST liquidar-tramo {tramo_id: T}` → debe rechazar (`PA032`) sin mover XLM. Con otro tramo U:
liquidarlo con `liquidar-tramo` → `estado_liquidacion = 'liquidado'`; luego `repartir-tramo` sobre U
→ `409 PA032`. Cero transacciones nuevas en Horizon en ambos rechazos. Además, comprobar que el
flujo de `liquidacion-tramo` sigue funcionando en un tramo virgen (su `quickstart.md`), incluido
marcar facturas con `actualizar_estado_cobro_factura`.

## 2. Reloj por pool (Historia 4)

1. `estado_reloj_pool(pool A)` y `(pool B)` → `adelantado: false`, `ahora_efectivo ≈ ahora_real`.
2. Como operador: `avanzar_reloj_pool(pool A, 30, 0)` → `desplazamiento_dias: 30`.
3. `estado_reloj_pool(pool B)` → **sigue** `adelantado: false` (independencia).
4. `detalle_pool(pool A)` → `fecha_efectiva` ≈ hoy + 30 d, facturas con vencimiento < esa fecha
   con `vencida: true`; `detalle_pool(pool B)` → sin `vencida`.
5. `avanzar_reloj_pool(pool A, 0, 0)` y con `-1` → `PA037`. Como inversionista → `PA008`.
6. Con el reloj de A adelantado: `registrar_factura` OK, un aporte a **B** OK, `recargar-wallet` OK
   (reloj real), un aporte a **A** OK con cotización nueva (vigente 5 min efectivos).
7. Cotizar en A, avanzar A un día, confirmar → cotización caducada (`PA004`); el cupo queda libre.

## 3. Cobro simulado (Historia 1)

Datos: factura F1 asignada a un tramo, `pendiente`.

1. `POST cobrar-factura {factura_id: F1}` como operador → `200`, `estado_cobro: cobrada`,
   `cobro.tx_hash`.
2. **Evidencia on-chain**: abrir `https://horizon-testnet.stellar.org/transactions/<tx_hash>` →
   pago nativo de `cuenta_origen` (deudor) a `cuenta_destino` (custodia del pool) por
   `monto_xlm`, memo `cobro:…`. Comprobar en la fila de `cobros_factura` que
   `monto_xlm = round(monto_nominal / tipo_cambio_aplicado, 7)`.
3. Repetir la llamada → `200` con `ya_existia`/`PA031`, **sin** segunda transacción (Horizon:
   ningún pago nuevo con ese memo).
4. Como inversionista → `403 PA008`. Sobre una factura sin asignar → `409 PA031`.
5. **Fondos del deudor** (riesgo de research §4): cobrar una factura cuyo XLM supere el saldo del
   deudor → la función repone vía Friendbot + merge y cobra; comprobar `saldo deudor` antes/después.
6. **Fallo**: apuntar temporalmente `custody_public_key` de un pool de prueba a una cuenta
   inexistente (o forzar un timeout) → `502 PA034`, factura `pendiente`, cobro `fallido`; corregir
   y reintentar → cobro nuevo `confirmado`, un solo pago en Horizon.

## 4. Mora y cascada (Historias 1 y 2)

Ejemplo numérico (pool PEN, tasa `0.36` PEN/XLM). Aportes confirmados: **junior** A = 3 000 XLM
(3 fracciones), B = 2 000 XLM (2 fracciones) → capital junior 5 000; **senior** C = 10 000 XLM.
Facturas del pool: FS (senior) nominal S/20 000, anticipo S/18 000; FJ (junior) nominal S/1 000,
anticipo S/900.

1. Cobrar FS → rendimiento del senior = S/2 000 → `2 000 / 0.36 ≈ 5 555.5555555` XLM.
2. Marcar FJ en mora (`marcar-factura-mora`) → pérdida S/900 → `900 / 0.36 = 2 500` XLM.
3. Como FS y FJ son las únicas facturas y ambas ya son finales, el reparto se dispara solo.
4. **Cascada** (`estado_reparto_pool`): `perdida_junior_xlm = 2 500`, `perdida_senior_xlm = 0`.
5. **Pagos esperados**: A = 3 000 − 2 500×3/5 = **1 500**; B = 2 000 − 2 500×2/5 = **1 000**;
   C = 10 000 + 5 555.5555555 = **15 555.5555555** (redondeo hacia abajo a 7 decimales).
6. Horizon: 3 pagos nativos de la custodia a las wallets de A, B y C, uno por inversionista, con
   memo `rep:…`. `mis_repartos()` de cada inversionista muestra su monto y `tx_hash`.
7. Variante de pérdida mayor: mora de anticipo S/3 600 (10 000 XLM) → junior A y B reciben 0
   y el senior absorbe 5 000 XLM: C = 10 000 − 5 000 + rendimiento del senior. Verificar contra la
   fórmula y contra la fila de `liquidaciones_pool`.
8. **Cascada**: `liquidaciones_pool` tiene exactamente las cifras esperadas; `repartos_tramo` de
   cada tramo en `cerrado` con `total_pagado_xlm` = suma de los pagos.

## 5. Reparto forzado (Historia 3)

1. Pool con FS `cobrada` y una factura `pendiente`. `POST repartir-tramo {tramo_id, forzar:true}`.
2. La factura pendiente pasa a `en_mora` con `cierre_forzado = true`; su anticipo cuenta como
   pérdida; `estado_reparto_pool` lista esa factura y `origen: forzado`.
3. El otro tramo pasa a repartible y se reparte con la misma liquidación (`liquidaciones_pool`
   tiene una sola fila por pool; no se recalcula).
4. Como inversionista → `403 PA008`. Tramo sin inversionistas → `409 PA036`.

## 6. Fallo parcial y reintento (decisión 4)

1. Antes de repartir, dejar a un inversionista con `wallet_destino` inválida (o forzar fallo del
   segundo pago). Ejecutar el reparto.
2. Esperado: pagos previos `pagado` con hash; el fallido `fallido` con `motivo_fallo`; `reparto` en
   `en_curso`; el tramo **no** está `cerrado`; respuesta `502 PA034` con `pagos`.
3. Corregir la causa y volver a llamar `repartir-tramo {tramo_id}` → solo se paga al pendiente;
   Horizon muestra **un** pago por inversionista (ninguno repetido); al llegar a 100 % `pagado`
   el tramo pasa a `cerrado`.

## 7. Irreversibilidad y concurrencia

1. Con un tramo `cerrado`: `repartir-tramo` → `409 PA032`; `cobrar-factura`/`marcar-factura-mora`
   sobre sus facturas → `409 PA032`. Cero transacciones nuevas en Horizon.
2. **Ráfaga**: 20 llamadas simultáneas de `repartir-tramo` (y de `cobrar-factura`) sobre el mismo
   tramo/factura → exactamente 1 reparto / 1 cobro; en Horizon, un pago por inversionista y por
   factura; el resto responde `PA032`/`ya_existia`.
3. **Dos pools, dos relojes**: adelantar A 60 días, completar el ciclo en A y, en paralelo,
   cotizar/aportar en B → B no ve efectos de reloj.

## 8. Cierre

- `git status` limpio en `supabase/`; sección nueva en `README.md` para este módulo.
- Criterios de éxito de la spec cubiertos: SC-001 (§3), SC-002/SC-006 (§4), SC-003 (§7),
  SC-004/SC-005 (§4), SC-007 (todo el ciclo < 3 min: §2–§4), SC-008 (`mis_repartos`), SC-009 (§2),
  SC-010 (§3.6, §6).
