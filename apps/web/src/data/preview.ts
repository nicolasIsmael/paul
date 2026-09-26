import type { Balance, ContributionResult, LiquidationTranche, OperatorInvoice, Pool, PoolDetail, Position, Profile, Quote, TopUpResult, TrancheType } from "../types/domain";

const previewRole = new URLSearchParams(window.location.search).get("role") === "operator"
  ? "operador_banco"
  : "inversionista";

export const previewProfile: Profile = {
  rol: previewRole,
  nombre_completo: previewRole === "operador_banco" ? "Operador Demo" : "Andrea Mendoza",
  telefono: "+51 987 654 321",
  foto_url: null,
  wallet_public_key: "GA3F7XPQ6VZXK5P9L2QC8W7H4EJMDYXR6B2NZL4HU8W9T5K2",
  es_cuenta_demo: true,
};

export const previewBalances: Balance[] = [
  { moneda: "PEN", saldo: 1250 },
  { moneda: "USD", saldo: 350 },
];

export const previewPools: Pool[] = [
  { id: "pool-solar", nombre: "Energía Solar Perú", moneda: "PEN", plazo_dias: 60, perfil_riesgo: "conservador", estado: "abierto", capital_objetivo: 50000, capital_comprometido: 38750, avance_pct: 77.5, sectores: ["tecnologia", "servicios"] },
  { id: "pool-agro", nombre: "Agroexportación Norte", moneda: "USD", plazo_dias: 90, perfil_riesgo: "balanceado", estado: "abierto", capital_objetivo: 32000, capital_comprometido: 18240, avance_pct: 57, sectores: ["manufactura"] },
  { id: "pool-retail", nombre: "Retail Andino", moneda: "PEN", plazo_dias: 30, perfil_riesgo: "conservador", estado: "abierto", capital_objetivo: 28000, capital_comprometido: 24640, avance_pct: 88, sectores: ["retail"] },
  { id: "pool-real-estate", nombre: "Infraestructura Urbana", moneda: "USD", plazo_dias: 90, perfil_riesgo: "agresivo", estado: "abierto", capital_objetivo: 65000, capital_comprometido: 19500, avance_pct: 30, sectores: ["construccion"] },
  { id: "pool-tech", nombre: "Servicios Digitales", moneda: "PEN", plazo_dias: 60, perfil_riesgo: "balanceado", estado: "fondeado", capital_objetivo: 40000, capital_comprometido: 40000, avance_pct: 100, sectores: ["tecnologia"] },
];

export const previewPositions: Position[] = [
  { aporte_id: "aporte-1", pool_id: "pool-solar", pool_nombre: "Energía Solar Perú", pool_estado: "abierto", tramo_tipo: "senior", monto_nominal: 500, moneda: "PEN", xlm_pagados: 1388.8889, tipo_cambio_aplicado: 0.36, confirmado_at: "2026-09-19T16:30:00Z" },
  { aporte_id: "aporte-2", pool_id: "pool-agro", pool_nombre: "Agroexportación Norte", pool_estado: "abierto", tramo_tipo: "junior", monto_nominal: 220, moneda: "USD", xlm_pagados: 611.1111, tipo_cambio_aplicado: 0.36, confirmado_at: "2026-09-18T20:15:00Z" },
  { aporte_id: "aporte-3", pool_id: "pool-retail", pool_nombre: "Retail Andino", pool_estado: "abierto", tramo_tipo: "senior", monto_nominal: 300, moneda: "PEN", xlm_pagados: 833.3333, tipo_cambio_aplicado: 0.36, confirmado_at: "2026-09-16T14:05:00Z" },
];

export const previewLiquidationTranches: LiquidationTranche[] = [
  { tramo_id: "tramo-solar-senior", pool_id: "pool-solar", pool_nombre: "Energía Solar Perú", moneda: "PEN", pool_estado: "fondeado", tramo_tipo: "senior", rendimiento_pct: 3.2, capital_comprometido: 35000, estado_liquidacion: "activo", token_contract_id: "CDL6PREVIEWSTELLARCONTRACTSENIOR", facturas_total: 2, facturas_cobradas: 1, facturas_pendientes: 1, facturas_en_mora: 0, inversionistas_total: 3, resultados_pagados: 0, resultados_compensados: 0 },
  { tramo_id: "tramo-solar-junior", pool_id: "pool-solar", pool_nombre: "Energía Solar Perú", moneda: "PEN", pool_estado: "fondeado", tramo_tipo: "junior", rendimiento_pct: 7.8, capital_comprometido: 15000, estado_liquidacion: "liquidando", token_contract_id: "CDL6PREVIEWSTELLARCONTRACTJUNIOR", facturas_total: 1, facturas_cobradas: 1, facturas_pendientes: 0, facturas_en_mora: 0, inversionistas_total: 2, resultados_pagados: 1, resultados_compensados: 0 },
  { tramo_id: "tramo-agro-senior", pool_id: "pool-agro", pool_nombre: "Agroexportación Norte", moneda: "USD", pool_estado: "cerrado", tramo_tipo: "senior", rendimiento_pct: 4.1, capital_comprometido: 22400, estado_liquidacion: "liquidado", token_contract_id: "CDL6PREVIEWSTELLARCONTRACTPAID", facturas_total: 1, facturas_cobradas: 1, facturas_pendientes: 0, facturas_en_mora: 0, inversionistas_total: 2, resultados_pagados: 2, resultados_compensados: 0 },
];

export const previewOperatorInvoices: OperatorInvoice[] = [
  { id: "factura-1", proveedor_nombre: "Soluciones Andinas SAC", deudor_nombre: "Energía Lima SA", deudor_sector: "servicios", moneda: "PEN", monto_nominal: 28000, fecha_emision: "2026-08-18", fecha_vencimiento: "2026-10-18", estado_validacion: "aprobada", motivo_rechazo: null, estado_asignacion: "asignada", estado_cobro: "cobrada", pool_id: "pool-solar", tramo_id: "tramo-solar-senior", anticipo: 21000 },
  { id: "factura-2", proveedor_nombre: "Paneles del Sur SAC", deudor_nombre: "Infraestructura Verde SA", deudor_sector: "construccion", moneda: "PEN", monto_nominal: 19000, fecha_emision: "2026-08-25", fecha_vencimiento: "2026-10-25", estado_validacion: "aprobada", motivo_rechazo: null, estado_asignacion: "asignada", estado_cobro: "pendiente", pool_id: "pool-solar", tramo_id: "tramo-solar-senior", anticipo: 14000 },
  { id: "factura-3", proveedor_nombre: "Servicios Fotovoltaicos SAC", deudor_nombre: "Energía Lima SA", deudor_sector: "servicios", moneda: "PEN", monto_nominal: 20000, fecha_emision: "2026-08-20", fecha_vencimiento: "2026-10-20", estado_validacion: "aprobada", motivo_rechazo: null, estado_asignacion: "asignada", estado_cobro: "cobrada", pool_id: "pool-solar", tramo_id: "tramo-solar-junior", anticipo: 15000 },
  { id: "factura-4", proveedor_nombre: "Agroinsumos Norte SAC", deudor_nombre: "Exportadora Pacífico SA", deudor_sector: "manufactura", moneda: "USD", monto_nominal: 30000, fecha_emision: "2026-07-10", fecha_vencimiento: "2026-10-10", estado_validacion: "aprobada", motivo_rechazo: null, estado_asignacion: "asignada", estado_cobro: "cobrada", pool_id: "pool-agro", tramo_id: "tramo-agro-senior", anticipo: 22400 },
];

export function previewPoolDetail(poolId: string): PoolDetail {
  const pool = previewPools.find((item) => item.id === poolId) || previewPools[0];
  const seniorTarget = pool.capital_objetivo * 0.7;
  const juniorTarget = pool.capital_objetivo * 0.3;
  const seniorCommitted = Math.min(seniorTarget, pool.capital_comprometido * 0.68);
  const juniorCommitted = Math.min(juniorTarget, pool.capital_comprometido - seniorCommitted);
  return {
    id: pool.id,
    nombre: pool.nombre,
    descripcion_corta: "Pool diversificado de facturas confirmadas con pagadores empresariales y trazabilidad sobre Stellar Testnet.",
    moneda: pool.moneda,
    plazo_dias: pool.plazo_dias,
    fecha_vencimiento_esperada: "2026-12-19",
    perfil_riesgo: pool.perfil_riesgo,
    perfil_riesgo_explicacion: "Exposición diversificada con plazos cortos y seguimiento agregado del financiamiento.",
    estado: pool.estado,
    composicion: { numero_operaciones: 14, numero_empresas: 9, sectores: pool.sectores, concentracion_maxima_pct: 12.5 },
    tramos: {
      senior: { capital_objetivo: seniorTarget, capital_comprometido: seniorCommitted, avance_pct: Number((seniorCommitted / seniorTarget * 100).toFixed(1)), cupo_disponible: seniorTarget - seniorCommitted, rendimiento_ilustrativo_plazo_pct: 3.2, rendimiento_ilustrativo_anualizado_pct: 6.4 },
      junior: { capital_objetivo: juniorTarget, capital_comprometido: juniorCommitted, avance_pct: Number((juniorCommitted / juniorTarget * 100).toFixed(1)), cupo_disponible: juniorTarget - juniorCommitted, rendimiento_ilustrativo_plazo_pct: 7.8, rendimiento_ilustrativo_anualizado_pct: 15.6 },
    },
    colchon_junior_pct: 30,
    aporte_minimo: { moneda: pool.moneda, monto: pool.moneda === "PEN" ? 100 : 50, equivalente_xlm: pool.moneda === "PEN" ? 277.7778 : 138.8889, tipo_cambio_disponible: true },
    comparacion_tramos: {
      senior: "Si una empresa pagadora no paga, el tramo junior absorbe la pérdida primero. El tramo senior solo se ve afectado si las pérdidas superan ese colchón.",
      junior: "Si una empresa pagadora no paga, el tramo junior es el primero en absorber la pérdida, antes que el senior. A cambio, asume más riesgo.",
    },
    disclaimer_rendimiento: "Rendimiento ilustrativo, sin garantía, en red de pruebas.",
  };
}

export function previewTopUp(moneda: "PEN" | "USD", monto: number): TopUpResult {
  const montoXlm = monto / (moneda === "PEN" ? 0.36 : 0.1);
  return { ok: true, recarga_id: crypto.randomUUID(), saldo_actualizado: (previewBalances.find((item) => item.moneda === moneda)?.saldo || 0) + monto, moneda, monto_xlm: montoXlm, tx_hash: null, wallet_public_key: previewProfile.wallet_public_key!, balance_xlm: 8610.8399767 + montoXlm, red: "stellar-testnet", simulado: true, recargado_hoy_equivalente_soles: monto, tope_diario_equivalente_soles: 1000, disponible_para_recargar_hoy: Math.max(0, 1000 - monto), se_reinicia_at: "2026-09-21T05:00:00Z" };
}

export function previewQuote(poolId: string, tramo: TrancheType, monto: number): Quote {
  const detail = previewPoolDetail(poolId);
  const rate = detail.moneda === "PEN" ? 0.36 : 0.1;
  return { cotizacion_id: crypto.randomUUID(), pool_id: poolId, tramo_tipo: tramo, monto_nominal: monto, moneda: detail.moneda, tipo_cambio_aplicado: rate, tipo_cambio_marca_tiempo: new Date().toISOString(), tipo_cambio_nota: "Parámetro de demostración. Testnet, sin valor de mercado real.", monto_xlm: monto / rate, expira_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
}

export function previewContribution(quoteId: string): ContributionResult {
  void quoteId;
  return { ok: true, aporte: { id: crypto.randomUUID(), pool_id: "pool-solar", tramo_id: "tramo-preview", monto_nominal: 300, moneda: "PEN", xlm_pagados: 833.3333, tipo_cambio_aplicado: 0.36, confirmado_at: new Date().toISOString() }, comprobante: { tx_hash: null, red: "stellar-testnet", simulado: true } };
}
