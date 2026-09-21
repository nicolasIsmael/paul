export type Role = "inversionista" | "operador_banco";
export type Currency = "PEN" | "USD";
export type RiskProfile = "conservador" | "balanceado" | "agresivo";
export type PoolStatus = "abierto" | "fondeado" | "cerrado";
export type TrancheType = "senior" | "junior";

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
  saldo_actualizado: number;
  moneda: Currency;
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

export type ApiErrorShape = {
  code: string;
  message: string;
  cupo_disponible?: number;
  disponible_para_recargar_hoy?: number;
  se_reinicia_at?: string;
};
