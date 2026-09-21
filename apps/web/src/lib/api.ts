import type { Session } from "@supabase/supabase-js";
import {
  previewBalances,
  previewContribution,
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

  async topUp(currency: Currency, amount: number) {
    if (isPreviewMode) return previewTopUp(currency, amount);
    return unwrap<TopUpResult>(
      supabase.rpc("recargar_saldo_demo", { p_moneda: currency, p_monto: amount }),
    );
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
};
