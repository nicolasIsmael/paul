import type { Currency, PoolStatus, RiskProfile, TrancheType } from "../types/domain";

const locale = "es-PE";

export function money(value: number, currency: Currency) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

export function compactMoney(value: number, currency: Currency) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value));
}

export function number(value: number, digits = 2) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(Number(value));
}

export function date(value: string) {
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" }).format(
    new Date(value),
  );
}

export function dateTime(value: string) {
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortKey(value: string | null) {
  if (!value) return "En preparación";
  return `${value.slice(0, 7)}...${value.slice(-6)}`;
}

export function roleLabel(role: "inversionista" | "operador_banco") {
  return role === "inversionista" ? "Inversionista" : "Operador de banco";
}

export function riskLabel(risk: RiskProfile) {
  return { conservador: "Conservador", balanceado: "Balanceado", agresivo: "Agresivo" }[risk];
}

export function statusLabel(status: PoolStatus) {
  return { abierto: "Abierto", fondeado: "Fondeado", cerrado: "Cerrado" }[status];
}

export function trancheLabel(tranche: TrancheType) {
  return tranche === "senior" ? "Senior" : "Junior";
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}
