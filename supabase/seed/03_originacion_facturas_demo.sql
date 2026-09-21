-- Feature: Originación de Facturas y Tokenización de Fracciones de Pool
-- (specs/20260920-174938-originacion-facturas-pool)
-- T049 (Polish): datos de ejemplo de originación — seguro para remoto, `on conflict ... do
-- nothing` / chequeo `if not exists` sobre uuids fijos (FR-030..FR-032). Cubre los estados
-- exigidos: pendiente, cobrada, en_mora, rechazada (dato de ejemplo, nunca asignada) y una
-- aprobada sin asignar lista para demostrar Historia 2/3 en vivo durante la demo. Proveedores y
-- deudores ficticios, sin marcas reales.
--
-- IMPORTANTE: las facturas que sí se asignan a un pool/tramo pasan por las RPC reales
-- (asignar_factura_a_pool/confirmar_asignacion_factura), nunca por un INSERT directo con
-- estado_asignacion='asignada' — un INSERT directo dejaría los agregados del tramo
-- (monto_financiado_acumulado/fracciones_totales/reserva/capital_objetivo) desincronizados,
-- porque esos campos solo los actualiza la propia función (hallazgo verificado en vivo contra el
-- proyecto real durante /speckit-implement).

insert into
  public.proveedores (id, nombre_comercial)
values
  ('f0000000-0000-4000-8000-000000000001', 'Ferretería El Tornillo'),
  ('f0000000-0000-4000-8000-000000000002', 'Insumos Andinos SRL'),
  ('f0000000-0000-4000-8000-000000000003', 'Textiles del Sur EIRL')
on conflict (id) do nothing;

-- Factura ya asignada y COBRADA (Historia 5 — estado de cobro como hecho, sin rendimiento).
insert into
  public.facturas (
    id, proveedor_id, empresa_id, moneda, monto_nominal, fecha_emision, fecha_vencimiento,
    huella_hash, estado_validacion
  )
values
  (
    'e0000000-0000-4000-8000-000000000101',
    'f0000000-0000-4000-8000-000000000001',
    'd0000000-0000-4000-8000-000000000001',
    'PEN', 2000.00, current_date - interval '20 days', current_date + interval '10 days',
    encode(
      extensions.digest (
        'f0000000-0000-4000-8000-000000000001d0000000-0000-4000-8000-0000000000012000.00PEN' ||
        (current_date - interval '20 days')::text || (current_date + interval '10 days')::text,
        'sha256'
      ),
      'hex'
    ),
    'aprobada'
  )
on conflict (id) do nothing;

-- Factura ya asignada y EN MORA.
insert into
  public.facturas (
    id, proveedor_id, empresa_id, moneda, monto_nominal, fecha_emision, fecha_vencimiento,
    huella_hash, estado_validacion
  )
values
  (
    'e0000000-0000-4000-8000-000000000102',
    'f0000000-0000-4000-8000-000000000002',
    'd0000000-0000-4000-8000-000000000002',
    'PEN', 1500.00, current_date - interval '50 days', current_date - interval '5 days',
    encode(
      extensions.digest (
        'f0000000-0000-4000-8000-000000000002d0000000-0000-4000-8000-0000000000021500.00PEN' ||
        (current_date - interval '50 days')::text || (current_date - interval '5 days')::text,
        'sha256'
      ),
      'hex'
    ),
    'aprobada'
  )
on conflict (id) do nothing;

-- Asigna ambas al pool POOL-PEN-001 (senior/junior respectivamente) vía las RPC reales, solo si
-- todavía no están asignadas (repetible sin duplicar ni desincronizar agregados). El tx_hash de
-- ejemplo es un placeholder claramente rotulado como tal — ninguna factura de seed pasa por un
-- contrato Soroban real (eso exige contracts/scripts/deploy.sh ya corrido, fuera del alcance de
-- este archivo).
do $$
begin
  if (select estado_asignacion from public.facturas where id = 'e0000000-0000-4000-8000-000000000101') = 'sin_asignar' then
    perform public.asignar_factura_a_pool(
      'e0000000-0000-4000-8000-000000000101', 'c0000000-0000-4000-8000-000000000101', 2000.00
    );
    perform public.confirmar_asignacion_factura('e0000000-0000-4000-8000-000000000101', 'SEED_TX_HASH_PLACEHOLDER_101');
  end if;

  if (select estado_asignacion from public.facturas where id = 'e0000000-0000-4000-8000-000000000102') = 'sin_asignar' then
    perform public.asignar_factura_a_pool(
      'e0000000-0000-4000-8000-000000000102', 'c0000000-0000-4000-8000-000000000102', 1500.00
    );
    perform public.confirmar_asignacion_factura('e0000000-0000-4000-8000-000000000102', 'SEED_TX_HASH_PLACEHOLDER_102');
  end if;
end $$;

update public.facturas set estado_cobro = 'cobrada' where id = 'e0000000-0000-4000-8000-000000000101' and estado_cobro <> 'cobrada';
update public.facturas set estado_cobro = 'en_mora' where id = 'e0000000-0000-4000-8000-000000000102' and estado_cobro <> 'en_mora';

-- Factura RECHAZADA (dato de ejemplo — nunca puede asignarse, FR-030). `registrar_factura` nunca
-- inserta una fila para un monto ≤ 0 o fechas incoherentes (PA014) — esos casos se rechazan sin
-- persistir nada (contracts/registrar-factura.md). El estado 'rechazada' sí queda persistido
-- cuando el dato en sí es coherente pero duplicado (PA015): esta fila simula exactamente ese
-- caso, con un monto/fechas válidos.
insert into
  public.facturas (
    id, proveedor_id, empresa_id, moneda, monto_nominal, fecha_emision, fecha_vencimiento,
    huella_hash, estado_validacion, motivo_rechazo
  )
values
  (
    'e0000000-0000-4000-8000-000000000103',
    'f0000000-0000-4000-8000-000000000003',
    'd0000000-0000-4000-8000-000000000003',
    'PEN', 500.00, current_date, current_date + interval '30 days',
    encode(
      extensions.digest (
        'f0000000-0000-4000-8000-000000000003d0000000-0000-4000-8000-000000000003500.00PEN' ||
        current_date::text || (current_date + interval '30 days')::text,
        'sha256'
      ),
      'hex'
    ),
    'rechazada', 'PA015'
  )
on conflict (id) do nothing;

-- Factura APROBADA sin asignar — lista para demostrar Historia 2/3 en vivo durante la demo
-- (asignar-factura), sin depender de que el operador registre una desde cero.
insert into
  public.facturas (
    id, proveedor_id, empresa_id, moneda, monto_nominal, fecha_emision, fecha_vencimiento,
    huella_hash, estado_validacion
  )
values
  (
    'e0000000-0000-4000-8000-000000000104',
    'f0000000-0000-4000-8000-000000000003',
    'd0000000-0000-4000-8000-000000000004',
    'PEN', 3200.00, current_date, current_date + interval '60 days',
    encode(
      extensions.digest (
        'f0000000-0000-4000-8000-000000000003d0000000-0000-4000-8000-0000000000043200.00PEN' ||
        current_date::text || (current_date + interval '60 days')::text,
        'sha256'
      ),
      'hex'
    ),
    'aprobada'
  )
on conflict (id) do nothing;

-- Nota: las facturas PENDIENTES ya existen de sobra — todas las 22 filas retrocompletadas por
-- 0011_proveedores_facturas.sql nacieron con estado_cobro = 'pendiente' por defecto, más la
-- factura 104 (aprobada, sin asignar, también 'pendiente' por defecto aunque todavía no cuenta
-- para ningún pool). No hace falta insertar una "pendiente" adicional ya asignada para cumplir
-- FR-030.
