export type Role = "inversionista" | "operador_banco";
export type Currency = "PEN" | "USD";
export type RiskProfile = "conservador" | "balanceado" | "agresivo";
export type PoolStatus = "abierto" | "fondeado" | "cerrado";
export type TrancheType = "senior" | "junior";
export type CollectionStatus = "pendiente" | "cobrada" | "en_mora";
export type LiquidationStatus = "activo" | "liquidando" | "liquidado";

export type Profile = {
  rol: Role;
  nombre_completo: string;
  telefono: string | null;
  foto_url: string | null;
  wallet_public_key: string | null;
  es_cuenta_demo: boolean;
};

export type Pool = {
  id: string;
  nombre: string;
  moneda: Currency;
  plazo_dias: number;
  perfil_riesgo: RiskProfile;
  estado: PoolStatus;
  capital_objetivo: number;
  capital_comprometido: number;
  avance_pct: number;
  sectores: string[];
};

export type PoolFilters = {
  moneda: Currency | "";
  plazo: number | null;
  riesgo: RiskProfile | "";
  sector: string;
  estado: PoolStatus | "";
  orden: "avance_desc" | "avance_asc" | "monto_desc" | "monto_asc" | "vencimiento_asc";
};

export type Tranche = {
  capital_objetivo: number;
  capital_comprometido: number;
  avance_pct: number;
  cupo_disponible: number;
  rendimiento_ilustrativo_plazo_pct: number;
  rendimiento_ilustrativo_anualizado_pct: number;
};

export type PoolDetail = {
  id: string;
  nombre: string;
  descripcion_corta: string;
  moneda: Currency;
  plazo_dias: number;
  fecha_vencimiento_esperada: string;
  perfil_riesgo: RiskProfile;
  perfil_riesgo_explicacion: string;
  estado: PoolStatus;
  composicion: {
    numero_operaciones: number;
    numero_empresas: number;
    sectores: string[];
    concentracion_maxima_pct: number;
  };
  tramos: Record<TrancheType, Tranche>;
  colchon_junior_pct: number;
  aporte_minimo: {
    moneda: Currency;
    monto: number;
    equivalente_xlm: number | null;
    tipo_cambio_disponible: boolean;
  };
  comparacion_tramos: Record<TrancheType, string>;
  disclaimer_rendimiento: string;
};

export type Balance = { moneda: Currency; saldo: number };

export type TopUpResult = {
  ok: true;
  recarga_id: string;
  saldo_actualizado: number;
  moneda: Currency;
  monto_xlm: number;
  tx_hash: string | null;
  wallet_public_key: string;
  balance_xlm: number | null;
  red: "stellar-testnet";
  simulado?: boolean;
  recargado_hoy_equivalente_soles: number;
  tope_diario_equivalente_soles: number;
  disponible_para_recargar_hoy: number;
  se_reinicia_at: string;
};

export type Quote = {
  cotizacion_id: string;
  pool_id: string;
  tramo_tipo: TrancheType;
  monto_nominal: number;
  moneda: Currency;
  tipo_cambio_aplicado: number;
  tipo_cambio_marca_tiempo: string;
  tipo_cambio_nota: string;
  monto_xlm: number;
  expira_at: string;
};

export type Position = {
  aporte_id: string;
  pool_id: string;
  pool_nombre: string;
  pool_estado: PoolStatus;
  tramo_tipo: TrancheType;
  monto_nominal: number;
  moneda: Currency;
  xlm_pagados: number;
  tipo_cambio_aplicado: number;
  confirmado_at: string;
};

export type ContributionResult = {
  ok: true;
  aporte: {
    id: string;
    pool_id: string;
    tramo_id: string;
    monto_nominal: number;
    moneda: Currency;
    xlm_pagados: number;
    tipo_cambio_aplicado: number;
    confirmado_at: string;
  };
  comprobante: {
    tx_hash: string | null;
    red: "stellar-testnet";
    simulado: boolean;
  };
};

export type OperatorInvoice = {
  id: string;
  proveedor_nombre: string;
  deudor_nombre: string;
  deudor_sector: string;
  moneda: Currency;
  monto_nominal: number;
  fecha_emision: string;
  fecha_vencimiento: string;
  estado_validacion: "aprobada" | "rechazada";
  motivo_rechazo: string | null;
  estado_asignacion: "sin_asignar" | "pendiente_onchain" | "asignada";
  estado_cobro: CollectionStatus;
  pool_id: string | null;
  tramo_id: string | null;
  anticipo: number | null;
};

export type LiquidationTranche = {
  tramo_id: string;
  pool_id: string;
  pool_nombre: string;
  moneda: Currency;
  pool_estado: PoolStatus;
  tramo_tipo: TrancheType;
  rendimiento_pct: number;
  capital_comprometido: number;
  estado_liquidacion: LiquidationStatus;
  token_contract_id: string | null;
  facturas_total: number;
  facturas_cobradas: number;
  facturas_pendientes: number;
  facturas_en_mora: number;
  inversionistas_total: number;
  resultados_pagados: number;
  resultados_compensados: number;
};

export type LiquidationInvestorResult = {
  investor_id: string;
  fracciones: number;
  monto_pagado: number;
  estado: "pagado" | "compensado";
  motivo?: string;
  tx_hash_pago?: string;
  tx_hash_quema?: string;
};

export type LiquidationResult = {
  ok: true;
  tramo_id: string;
  estado_liquidacion: "liquidado";
  resultados: LiquidationInvestorResult[];
};

export type ApiErrorShape = {
  code: string;
  message: string;
  cupo_disponible?: number;
  disponible_para_recargar_hoy?: number;
  se_reinicia_at?: string;
};
