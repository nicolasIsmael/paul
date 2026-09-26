import type { ApiErrorShape } from "../types/domain";

type SupabaseLikeError = { code?: string; message?: string; details?: string | null };

const messages: Record<string, string> = {
  PA001: "El monto debe ser múltiplo del aporte mínimo.",
  PA002: "Tu saldo de demostración es insuficiente. Recarga antes de continuar.",
  PA003: "El monto supera el cupo disponible para este tramo.",
  PA004: "La cotización expiró. Genera una nueva para continuar.",
  PA005: "Esta cotización ya fue utilizada. Genera una nueva.",
  PA006: "Este pool ya no admite nuevos aportes.",
  PA007: "Tu wallet todavía se está preparando. Intenta nuevamente en unos segundos.",
  PA008: "Tu cuenta no tiene permisos para realizar esta operación.",
  PA009: "La wallet no tiene XLM suficiente para completar el pago.",
  PA010: "El tipo de cambio no está disponible. Intenta más tarde.",
  PA011: "La recarga supera el límite diario disponible.",
  PA012: "No encontramos el recurso solicitado.",
  PA013: "Stellar no pudo procesar la operación. Intenta nuevamente.",
  PA019: "Falta completar la configuración on-chain de este tramo.",
  PA021: "Este tramo ya fue liquidado.",
  PA022: "Todavía existen facturas sin cobrar en este tramo.",
  PA023: "No encontramos el tramo solicitado.",
  PA024: "Ya existe una liquidación en curso para este tramo.",
};

function parseDetails(details?: string | null) {
  if (!details) return {};
  try {
    return JSON.parse(details) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function normalizeError(error: unknown): ApiErrorShape {
  if (typeof error === "object" && error !== null) {
    const candidate = error as SupabaseLikeError & Record<string, unknown>;
    const code = candidate.code || "UNKNOWN";
    return {
      ...parseDetails(candidate.details),
      ...candidate,
      code,
      message: messages[code] || candidate.message || "Ocurrió un error inesperado.",
    } as ApiErrorShape;
  }
  return { code: "UNKNOWN", message: "Ocurrió un error inesperado." };
}
