-- Feature: Exploración de Pools y Primer Aporte del Inversionista
-- (specs/20260920-113925-inversion-pools-aporte)
-- T013: datos de ejemplo del dominio — seguro para aplicarse también contra el proyecto remoto
-- (no toca auth.users, solo referencia ids fijos vía FK cuando corresponda). Todo con
-- `on conflict ... do nothing` sobre claves estables (uuids fijos / pools.codigo) para poder
-- re-ejecutarse sin duplicar nada (FR-043). Empresas y montos totalmente ficticios, sin marcas
-- reales.
--
-- 6 pools cubren: 3 plazos (30/60/90 días), ambas monedas (5 en PEN, 1 en USD), los 3 perfiles de
-- riesgo, 5 sectores distintos, y los 4 estados de avance que pide FR-041 (casi vacío, medio
-- fondeado, casi lleno, y completamente fondeado — este último dispara el trigger
-- tramos_actualiza_estado_pool y pasa solo a estado='fondeado', sin fijarlo a mano).

-- Tipo de cambio de referencia inicial (FR-042).
insert into
  public.tipos_cambio_referencia (id, moneda, tasa_moneda_por_xlm, vigente_desde, nota)
values
  (
    'f0000000-0000-4000-8000-000000000001', 'PEN', 0.3600, now(),
    'Parámetro de demostración — testnet, sin valor de mercado real'
  ),
  (
    'f0000000-0000-4000-8000-000000000002', 'USD', 0.0950, now(),
    'Parámetro de demostración — testnet, sin valor de mercado real'
  )
on conflict (id) do nothing;

-- Empresas pagadoras ficticias (agrupadas por sector, reutilizadas entre pools del mismo sector).
insert into
  public.empresas_pagadoras (id, nombre_comercial, sector)
values
  ('d0000000-0000-4000-8000-000000000001', 'Comercial Andina SAC', 'retail'),
  ('d0000000-0000-4000-8000-000000000002', 'Bazar del Sur EIRL', 'retail'),
  ('d0000000-0000-4000-8000-000000000003', 'Distribuidora Rímac SAC', 'retail'),
  ('d0000000-0000-4000-8000-000000000004', 'Textiles Altiplano SAC', 'manufactura'),
  ('d0000000-0000-4000-8000-000000000005', 'Metalmecánica Pacífico SAC', 'manufactura'),
  ('d0000000-0000-4000-8000-000000000006', 'Consultora Horizonte SAC', 'servicios'),
  ('d0000000-0000-4000-8000-000000000007', 'Servicios Integrales Andes SAC', 'servicios'),
  ('d0000000-0000-4000-8000-000000000008', 'Constructora Miraflores SAC', 'construccion'),
  ('d0000000-0000-4000-8000-000000000009', 'Edificaciones del Valle SAC', 'construccion'),
  ('d0000000-0000-4000-8000-00000000000a', 'Software Andino SAC', 'tecnologia'),
  ('d0000000-0000-4000-8000-00000000000b', 'Data Solutions Perú SAC', 'tecnologia')
on conflict (id) do nothing;

-- Pool 1: POOL-PEN-001 — Retail Norte (PEN, 30d, conservador) — casi vacío (~5%).
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000001', 'POOL-PEN-001', 'Retail Norte',
  'Financia facturas de tiendas y distribuidores de retail con pago a 30 días.',
  'PEN', 30, 'conservador',
  'Plazo corto y empresas pagadoras de retail establecidas: es la opción con menor variación esperada.',
  current_date + interval '30 days', 100.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000101', 'b0000000-0000-4000-8000-000000000001', 'senior', 14000.00, 700.00, 0.8, 9.5),
  ('c0000000-0000-4000-8000-000000000102', 'b0000000-0000-4000-8000-000000000001', 'junior', 6000.00, 300.00, 1.8, 19.0)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'PEN', 5000.00),
  ('e0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'PEN', 3000.00),
  ('e0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', 'PEN', 4500.00),
  ('e0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'PEN', 4000.00),
  ('e0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000003', 'PEN', 3500.00)
on conflict (id) do nothing;

-- Pool 2: POOL-PEN-002 — Manufactura Sur (PEN, 60d, balanceado) — a medio fondear (~50%).
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000002', 'POOL-PEN-002', 'Manufactura Sur',
  'Financia facturas de proveedores industriales con pago a 60 días.',
  'PEN', 60, 'balanceado',
  'Plazo intermedio con empresas del sector manufactura: equilibrio entre riesgo y rendimiento.',
  current_date + interval '60 days', 100.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000201', 'b0000000-0000-4000-8000-000000000002', 'senior', 28000.00, 14000.00, 1.6, 9.7),
  ('c0000000-0000-4000-8000-000000000202', 'b0000000-0000-4000-8000-000000000002', 'junior', 12000.00, 6000.00, 3.5, 21.0)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000004', 'PEN', 12000.00),
  ('e0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000004', 'PEN', 8000.00),
  ('e0000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000005', 'PEN', 11000.00),
  ('e0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000005', 'PEN', 9000.00)
on conflict (id) do nothing;

-- Pool 3: POOL-PEN-003 — Servicios Lima (PEN, 90d, agresivo) — casi lleno (~90%).
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000003', 'POOL-PEN-003', 'Servicios Lima',
  'Financia facturas de empresas de servicios profesionales con pago a 90 días.',
  'PEN', 90, 'agresivo',
  'Plazo más largo y mayor concentración por empresa: mayor rendimiento ilustrativo, mayor riesgo.',
  current_date + interval '90 days', 100.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000301', 'b0000000-0000-4000-8000-000000000003', 'senior', 40000.00, 36000.00, 2.3, 9.3),
  ('c0000000-0000-4000-8000-000000000302', 'b0000000-0000-4000-8000-000000000003', 'junior', 20000.00, 18000.00, 5.5, 22.3)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000006', 'PEN', 18000.00),
  ('e0000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000007', 'PEN', 16000.00),
  ('e0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000007', 'PEN', 14000.00),
  ('e0000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000006', 'PEN', 12000.00)
on conflict (id) do nothing;

-- Pool 4: POOL-PEN-004 — Construcción Centro (PEN, 60d, balanceado) — completamente fondeado
-- (100% exacto — el trigger tramos_actualiza_estado_pool debe pasarlo solo a 'fondeado').
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000004', 'POOL-PEN-004', 'Construcción Centro',
  'Financia facturas de subcontratistas de construcción con pago a 60 días.',
  'PEN', 60, 'balanceado',
  'Plazo intermedio con empresas del sector construcción: equilibrio entre riesgo y rendimiento.',
  current_date + interval '60 days', 100.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000401', 'b0000000-0000-4000-8000-000000000004', 'senior', 21000.00, 21000.00, 1.6, 9.7),
  ('c0000000-0000-4000-8000-000000000402', 'b0000000-0000-4000-8000-000000000004', 'junior', 9000.00, 9000.00, 3.6, 21.6)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000008', 'PEN', 16000.00),
  ('e0000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000009', 'PEN', 14000.00)
on conflict (id) do nothing;

-- Pool 5: POOL-USD-001 — Tecnología Exportadora (USD, 90d, agresivo) — abierto, ~40%.
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000005', 'POOL-USD-001', 'Tecnología Exportadora',
  'Financia facturas en dólares de empresas exportadoras de servicios tecnológicos, pago a 90 días.',
  'USD', 90, 'agresivo',
  'Plazo largo, en dólares, con menos empresas pagadoras: mayor rendimiento ilustrativo, mayor riesgo.',
  current_date + interval '90 days', 25.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000501', 'b0000000-0000-4000-8000-000000000005', 'senior', 6500.00, 2600.00, 2.5, 10.1),
  ('c0000000-0000-4000-8000-000000000502', 'b0000000-0000-4000-8000-000000000005', 'junior', 3500.00, 1400.00, 6.0, 24.3)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-00000000000a', 'USD', 3500.00),
  ('e0000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-00000000000b', 'USD', 3000.00),
  ('e0000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-00000000000a', 'USD', 2500.00)
on conflict (id) do nothing;

-- Pool 6: POOL-PEN-005 — Comercio y Tecnología Mixto (PEN, 30d, balanceado, 2 sectores) — abierto, ~15%.
insert into
  public.pools (
    id, codigo, nombre, descripcion_corta, moneda, plazo_dias, perfil_riesgo,
    perfil_riesgo_explicacion, fecha_vencimiento_esperada, unidad_minima_aporte
  )
values (
  'b0000000-0000-4000-8000-000000000006', 'POOL-PEN-005', 'Comercio y Tecnología Mixto',
  'Financia facturas combinadas de retail y proveedores tecnológicos locales, pago a 30 días.',
  'PEN', 30, 'balanceado',
  'Plazo corto con dos sectores distintos: diversifica el riesgo de concentración por industria.',
  current_date + interval '30 days', 100.00
)
on conflict (codigo) do nothing;

insert into
  public.tramos (
    id, pool_id, tipo, capital_objetivo, capital_comprometido,
    rendimiento_ilustrativo_plazo_pct, rendimiento_ilustrativo_anualizado_pct
  )
values
  ('c0000000-0000-4000-8000-000000000601', 'b0000000-0000-4000-8000-000000000006', 'senior', 10500.00, 1575.00, 0.9, 10.9),
  ('c0000000-0000-4000-8000-000000000602', 'b0000000-0000-4000-8000-000000000006', 'junior', 4500.00, 675.00, 2.0, 24.3)
on conflict (pool_id, tipo) do nothing;

insert into
  public.operaciones (id, pool_id, empresa_id, moneda, monto_nominal)
values
  ('e0000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000002', 'PEN', 4000.00),
  ('e0000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000003', 'PEN', 3500.00),
  ('e0000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-00000000000b', 'PEN', 4000.00),
  ('e0000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-00000000000a', 'PEN', 3000.00)
on conflict (id) do nothing;
