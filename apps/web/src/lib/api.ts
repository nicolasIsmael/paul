import type { Session } from "@supabase/supabase-js";
import {
  previewBalances,
  previewContribution,
  previewLiquidationTranches,
  previewOperatorInvoices,
  previewPoolDetail,
  previewPools,
  previewPositions,
  previewProfile,
  previewQuote,
  previewTopUp,
} from "../data/preview";
import { normalizeError } from "./errors";
import { edgeFunctionsUrl, isPreviewMode, supabase } from "./supabase";
import type {
  ApiErrorShape,
  Balance,
  ContributionResult,
  Currency,
  Pool,
  PoolDetail,
  PoolFilters,
  Position,
  Profile,
  Quote,
  CollectionStatus,
  LiquidationResult,
  LiquidationTranche,
  OperatorInvoice,
  TopUpResult,
  TrancheType,
} from "../types/domain";

async function unwrap<T>(promise: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw normalizeError(error);
  return data as T;
}

export const api = {
  async profile(userId: string) {
    if (isPreviewMode) return { ...previewProfile };
    return unwrap<Profile>(
      supabase
        .from("perfiles")
        .select("rol, nombre_completo, telefono, foto_url, wallet_public_key, es_cuenta_demo")
        .eq("id", userId)
        .single(),
    );
  },

  async updateProfile(userId: string, fields: Pick<Profile, "nombre_completo" | "telefono" | "foto_url">) {
    if (isPreviewMode) return fields;
    return unwrap<Pick<Profile, "nombre_completo" | "telefono" | "foto_url">>(
      supabase
        .from("perfiles")
        .update(fields)
        .eq("id", userId)
        .select("nombre_completo, telefono, foto_url")
        .single(),
    );
  },

  async pools(filters: PoolFilters) {
    if (isPreviewMode) {
      const filtered = previewPools.filter((pool) =>
        (!filters.moneda || pool.moneda === filters.moneda)
        && (!filters.plazo || pool.plazo_dias === filters.plazo)
        && (!filters.riesgo || pool.perfil_riesgo === filters.riesgo)
        && (!filters.sector || pool.sectores.includes(filters.sector))
        && (!filters.estado || pool.estado === filters.estado));
      return [...filtered].sort((a, b) => filters.orden === "avance_asc" ? a.avance_pct - b.avance_pct : filters.orden === "monto_asc" ? a.capital_objetivo - b.capital_objetivo : filters.orden === "monto_desc" ? b.capital_objetivo - a.capital_objetivo : b.avance_pct - a.avance_pct);
    }
    return unwrap<Pool[]>(
      supabase.rpc("catalogo_pools", {
        p_moneda: filters.moneda || null,
        p_plazo_dias: filters.plazo,
        p_perfil_riesgo: filters.riesgo || null,
        p_sector: filters.sector || null,
        p_estado: filters.estado || null,
        p_orden: filters.orden,
      }),
    );
  },

  async poolDetail(poolId: string) {
    if (isPreviewMode) return previewPoolDetail(poolId);
    return unwrap<PoolDetail>(supabase.rpc("detalle_pool", { p_pool_id: poolId }));
  },

  async balances() {
    if (isPreviewMode) return [...previewBalances];
    return unwrap<Balance[]>(supabase.rpc("mi_saldo_demostracion"));
  },

  async topUp(session: Session, currency: Currency, amount: number, idempotencyKey: string) {
    if (isPreviewMode) return previewTopUp(currency, amount);
    const response = await fetch(`${edgeFunctionsUrl}/recargar-wallet`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ moneda: currency, monto: amount, idempotency_key: idempotencyKey }),
    });
    const result = (await response.json()) as TopUpResult | { ok: false; error: ApiErrorShape };
    if (!response.ok || !result.ok) {
      throw normalizeError("error" in result ? result.error : undefined);
    }
    return result;
  },

  async stellarBalance(publicKey: string | null) {
    if (!publicKey) return null;
    if (isPreviewMode) return 8610.8399767;
    try {
      const response = await fetch(`https://horizon-testnet.stellar.org/accounts/${encodeURIComponent(publicKey)}`);
      if (!response.ok) return null;
      const account = await response.json() as { balances?: Array<{ asset_type: string; balance: string }> };
      const native = account.balances?.find((balance) => balance.asset_type === "native");
      return native ? Number(native.balance) : null;
    } catch {
      return null;
    }
  },

  async quote(poolId: string, tranche: TrancheType, amount: number) {
    if (isPreviewMode) return previewQuote(poolId, tranche, amount);
    return unwrap<Quote>(
      supabase.rpc("cotizar_aporte", {
        p_pool_id: poolId,
        p_tramo_tipo: tranche,
        p_monto: amount,
      }),
    );
  },

  async confirmContribution(session: Session, quoteId: string, idempotencyKey: string) {
    if (isPreviewMode) return previewContribution(quoteId);
    const response = await fetch(`${edgeFunctionsUrl}/confirmar-aporte`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cotizacion_id: quoteId, idempotency_key: idempotencyKey }),
    });
    const result = (await response.json()) as ContributionResult | { ok: false; error: ApiErrorShape };
    if (!response.ok || !result.ok) {
      throw normalizeError("error" in result ? result.error : undefined);
    }
    return result;
  },

  async positions() {
    if (isPreviewMode) return [...previewPositions];
    return unwrap<Position[]>(supabase.rpc("mis_posiciones"));
  },

  async operatorInvoices() {
    if (isPreviewMode) return previewOperatorInvoices.map((invoice) => ({ ...invoice })) as OperatorInvoice[];
    return unwrap<OperatorInvoice[]>(supabase.rpc("listar_facturas_operador", {
      p_estado_validacion: "aprobada",
      p_estado_asignacion: "asignada",
    }));
  },

  async liquidationTranches() {
    if (isPreviewMode) return previewLiquidationTranches.map((tranche) => ({ ...tranche })) as LiquidationTranche[];
    return unwrap<LiquidationTranche[]>(supabase.rpc("listar_tramos_liquidacion_operador"));
  },

  async updateInvoiceCollection(invoiceId: string, status: CollectionStatus) {
    if (isPreviewMode) return;
    await unwrap<void>(supabase.rpc("actualizar_estado_cobro_factura", {
      p_factura_id: invoiceId,
      p_nuevo_estado: status,
    }));
  },

  async liquidateTranche(session: Session, trancheId: string, idempotencyKey: string) {
    if (isPreviewMode) {
      return {
        ok: true,
        tramo_id: trancheId,
        estado_liquidacion: "liquidado",
        resultados: [
          { investor_id: "preview-investor-1", fracciones: 4, monto_pagado: 412.8, estado: "pagado" },
          { investor_id: "preview-investor-2", fracciones: 3, monto_pagado: 309.6, estado: "pagado" },
          { investor_id: "preview-investor-3", fracciones: 2, monto_pagado: 206.4, estado: "pagado" },
        ],
      } as LiquidationResult;
    }
    const response = await fetch(`${edgeFunctionsUrl}/liquidar-tramo`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tramo_id: trancheId, idempotency_key: idempotencyKey }),
    });
    const result = (await response.json()) as LiquidationResult | { ok: false; error: ApiErrorShape };
    if (!response.ok || !result.ok) throw normalizeError("error" in result ? result.error : undefined);
    return result;
  },
};
