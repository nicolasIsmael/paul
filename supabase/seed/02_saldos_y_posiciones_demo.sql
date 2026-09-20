-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T038: saldo de demostración inicial + al menos una posición previa para las 3 cuentas demo de
-- inversionista (FR-042) — seguro para aplicarse también contra el proyecto remoto: solo
-- referencia los ids fijos de las cuentas demo vía FK (ya existen ahí de verdad, creadas por la
-- feature previa), nunca las vuelve a crear. Todo con `on conflict ... do nothing`.
--
-- La posición previa se inserta directamente en estado 'confirmado' (sin pasar por el flujo real
-- de reservar/pagar/confirmar, que exige una transacción Stellar real) — su comprobante queda
-- marcado explícitamente como simulado (FR-033: nunca presentado como evidencia real). Es la
-- única fila de `aportes` de todo el seed; el resto del `capital_comprometido` que ya traen los
-- pools de `01_dominio_demo.sql` representa inversionistas ficticios fuera de este dataset de
-- demo, no aportes individuales modelados uno a uno.

-- Saldo inicial en soles para las 3 cuentas demo de inversionista.
insert into
  public.saldos_demostracion (investor_id, moneda, saldo)
values
  ('a0000000-0000-4000-8000-000000000001', 'PEN', 500.00),
  ('a0000000-0000-4000-8000-000000000002', 'PEN', 500.00),
  ('a0000000-0000-4000-8000-000000000003', 'PEN', 500.00)
on conflict (investor_id, moneda) do nothing;

-- Posición previa: inversionista.demo1 ya tiene un aporte confirmado en el tramo junior de
-- POOL-PEN-002 (Manufactura Sur), para poder mostrar "mis posiciones" sin esperar (FR-042).
insert into
  public.cotizaciones (
    id, investor_id, pool_id, tramo_id, monto_nominal, moneda, tipo_cambio_aplicado, monto_xlm,
    generado_at, expira_at, usada
  )
values (
  'a1000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000202',
  500.00, 'PEN', 0.3600, 1388.8888889,
  now() - interval '3 days', now() - interval '3 days' + interval '5 minutes', true
)
on conflict (id) do nothing;

insert into
  public.aportes (
    id, investor_id, pool_id, tramo_id, cotizacion_id, idempotency_key, monto_nominal, moneda,
    tipo_cambio_aplicado, xlm_pagados, estado, tx_hash, comprobante_simulado,
    reservado_at, expira_reserva_at, confirmado_at
  )
values (
  'a2000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002',
  'c0000000-0000-4000-8000-000000000202',
  'a1000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  500.00, 'PEN', 0.3600, 1388.8888889, 'confirmado', null, true,
  now() - interval '3 days', now() - interval '3 days' + interval '2 minutes', now() - interval '3 days'
)
on conflict (id) do nothing;
