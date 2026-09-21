# Quickstart: Originación de Facturas y Tokenización de Fracciones de Pool

Validación manual de extremo a extremo (Principio I — sin tests automatizados). Continúa
exactamente el mismo flujo de trabajo que la spec previa: `supabase start` local primero,
`supabase db push` a remoto después de validar, seed remoto explícito, nunca `db reset --linked`.

## 0. Prerrequisitos

- Proyecto local corriendo (`supabase start`) con todas las migraciones/seed de la spec previa ya
  aplicadas (pools, tramos, cuentas demo con wallet).
- `contracts/soroban-pool` compilado y desplegado en **testnet** vía
  `contracts/scripts/deploy.sh` (`contracts/deploy-contrato.md`) — necesario incluso para probar
  en local, porque el contrato vive en Stellar testnet, no en el Postgres local.
- `configuracion_red` poblada (paso 4 del script de despliegue) y los 10 tramos de ejemplo con
  `token_contract_id` ya asignado.

## 1. Registrar una factura válida y una inválida (Historia 1)

```sql
select registrar_factura(
  'Ferretería El Tornillo', 'Constructora Andina SAC', 'construccion', 'PEN',
  4500.00, current_date, current_date + interval '45 days'
);
-- Esperado: estado_validacion = 'aprobada', huella_hash no vacío.

select registrar_factura(
  'Ferretería El Tornillo', 'Constructora Andina SAC', 'construccion', 'PEN',
  -100.00, current_date, current_date + interval '45 days'
);
-- Esperado: estado_validacion = 'rechazada', motivo_rechazo = 'PA014'.
```

Repetir la primera llamada exacta una segunda vez → `estado_validacion = 'rechazada'`,
`motivo_rechazo = 'PA015'` (duplicada).

## 2. Rechazo por rol incorrecto

Con el JWT de una cuenta `inversionista`, llamar `registrar_factura(...)` → `error.code = 'PA008'`
(FR-005).

## 3. Asignar la factura aprobada a un pool/tramo (Historia 2 y 3)

```http
POST /functions/v1/asignar-factura
Authorization: Bearer <jwt operador>
{ "factura_id": "<id del paso 1>", "tramo_id": "<id de un tramo senior existente>", "anticipo": 4000.00 }
```

Verificar en la respuesta: `factura.estado_asignacion = 'asignada'`, `tramo_actualizado.
fracciones_totales` aumentó exactamente en `floor(4000 / unidad_minima_aporte del pool)`, y
`comprobante_onchain.tx_hash` no vacío.

**Verificación independiente en el contrato** (sin pasar por la plataforma — SC-005):

```bash
stellar contract invoke --id <token_contract_id del tramo> --network testnet -- cap
stellar contract invoke --id <token_contract_id del tramo> --network testnet -- total_supply
```

`cap` debe reflejar el nuevo `fracciones_totales`; `total_supply` sigue en `0` (todavía no hubo
ningún aporte de inversionista sobre este incremento).

## 4. Intentar asignar la misma factura dos veces

Repetir la llamada del paso 3 con los mismos `factura_id`/`tramo_id`/`anticipo` →
`ya_existia: true`, sin duplicar el incremento de `fracciones_totales` (comprobar con una consulta
directa a `tramos` antes y después).

Intentar asignarla a un `tramo_id` **distinto** → `error.code = 'PA018'`.

## 5. Anticipo inválido

`anticipo: 10000.00` sobre una factura de `monto_nominal = 4500.00` → `error.code = 'PA017'`.

## 6. Consultar las facturas anonimizadas del pool (Historia 4)

```sql
select * from facturas_del_pool('<pool_id>');
```

Verificar: cada fila trae `monto_nominal`/`sector`/`fecha_vencimiento`/`dias_plazo`/`estado_cobro`,
**nunca** una columna con nombre de proveedor o deudor. Confirmar también que una consulta directa
a `select * from facturas` o `select * from proveedores` con el JWT de un inversionista falla por
falta de privilegios (RLS deny-all) — la anonimización no depende solo de qué selecciona la
función, sino de que no exista ninguna otra vía.

```sql
select detalle_pool('<pool_id>');
```

Verificar el bloque nuevo `estado_facturas` (conteo de pendientes/cobradas/en_mora + `pct_cobrado`)
y que ningún campo del JSON contiene una palabra como "rendimiento esperado" asociada a estas
cifras — solo a `rendimiento_ilustrativo_*` de `tramos`, ya existente y sin relación con el estado
de cobro (SC-008 de esta spec).

## 7. Aporte de un inversionista tras la asignación (coherencia con la spec previa)

Ejecutar el flujo ya validado en la spec previa (`cotizar_aporte` → `confirmar-aporte`) contra el
tramo del paso 3. Verificar en la respuesta de `confirmar-aporte`:

- `comprobante.fraccion_tx_hash` no vacío, distinto de `comprobante.tx_hash`.
- Consultando el contrato directamente: `stellar contract invoke --id <token_contract_id> --network
  testnet -- balance --id <wallet_public_key del inversionista>` devuelve exactamente `monto_
  nominal / unidad_minima_aporte` fracciones — verificable **sin pasar por la plataforma** (SC-005
  de esta spec).

## 8. Concurrencia — nunca más fracciones que el cupo (SC-003)

`Promise.all` de 20 llamadas a `confirmar-aporte` sobre cotizaciones que en conjunto exceden el
último cupo disponible de un tramo (mismo guion que la spec previa, `quickstart.md` §5). Verificar
adicionalmente, tras la ráfaga:

```bash
stellar contract invoke --id <token_contract_id> --network testnet -- total_supply
```

`total_supply` debe ser exactamente igual a `capital_comprometido / unidad_minima_aporte` de
Postgres para ese tramo — nunca más, incluso bajo la ráfaga concurrente (el contrato serializa cada
`mint` por ledger, igual que Postgres serializa cada `UPDATE` de fila).

## 9. Fallo del contrato con reversión (simular, no forzar en producción)

Con un `token_contract_id` intencionalmente inválido en un tramo de prueba (o pausando la red
antes de invocar), confirmar un aporte y verificar:

- La respuesta llega en la misma solicitud con `ok: false`, `error.code = 'PA019'`.
- `reembolso.tx_hash` presente y verificable en Horizon (`https://horizon-testnet.stellar.org/
  transactions/<hash>`).
- El aporte queda `estado = 'revertido'`, `motivo_reversion = 'fallo_emision_fracciones'` — el
  cupo del tramo y el saldo de demostración del inversionista vuelven exactamente a su valor
  previo al intento.

## 10. Idempotencia del mint ante reintento de red

Repetir la misma solicitud de `confirmar-aporte` (mismo `idempotency_key`) después de un mint ya
exitoso → la función detecta `fraccion_tx_hash` ya poblado y devuelve el mismo resultado sin volver
a invocar `mint` (confirmar consultando `total_supply` del contrato antes y después: no cambia).

## 11. Seed de demostración de esta feature

`supabase/seed/03_originacion_facturas_demo.sql` (nuevo, seguro para remoto, `ON CONFLICT DO
NOTHING` sobre IDs fijos, mismo estilo que `01_dominio_demo.sql`):

- Retrocompleta `proveedor_id`/`huella_hash`/`estado_validacion`/`estado_asignacion = 'asignada'`
  sobre las 9 facturas ya sembradas por la spec previa (ahora `facturas`), para que
  `facturas_del_pool` no las muestre vacías de golpe.
- Inserta ≥6 facturas nuevas cubriendo los estados exigidos por FR-030: al menos una `pendiente`,
  una `cobrada`, una `en_mora`, una `rechazada` (dato de ejemplo, sin llegar nunca a asignarse), y
  al menos una recién `aprobada` sin asignar (para que Historia 2 sea demostrable en vivo durante
  la demo, no solo con datos ya asignados de antemano).
- Uno de los ≥5 pools de la spec previa queda con al menos una factura nueva asignada durante el
  propio guion de seed (para que exista evidencia on-chain fresca, no solo la retrocompletada) —
  requiere que `contracts/scripts/deploy.sh` ya se haya corrido antes de aplicar este archivo de
  seed (orden de despliegue de `plan.md`).

## 12. Antes de tocar el proyecto remoto

Mismo checklist que la spec previa (`quickstart.md` §7) más: confirmar que `configuracion_red`
remota apunta al **mismo** `token_wasm_hash`/`operador_authority_public_key` que se usó para
instanciar los `token_contract_id` ya escritos en `tramos` — un desajuste dejaría a
`asignar-factura`/`confirmar-aporte` intentando firmar con una autoridad que el contrato
desplegado no reconoce como `admin`.
