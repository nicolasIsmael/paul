import { ArrowRight, CalendarDays, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { compactMoney, riskLabel, statusLabel } from "../lib/format";
import type { Pool } from "../types/domain";
import { Badge, Progress } from "./ui";

const sectorLabels: Record<string, string> = {
  retail: "Retail",
  manufactura: "Manufactura",
  servicios: "Servicios",
  construccion: "Construcción",
  tecnologia: "Tecnología",
};

export function PoolCard({ pool }: { pool: Pool }) {
  const tone = pool.perfil_riesgo === "conservador" ? "success" : pool.perfil_riesgo === "agresivo" ? "warning" : "blue";
  return (
    <article className="pool-card">
      <header className="pool-card__header">
        <div className={`pool-card__visual pool-card__visual--${pool.sectores[0] || "general"}`}>
          <span>{pool.nombre.slice(0, 1)}</span>
        </div>
        <div className="pool-card__title">
          <div className="pool-card__badges"><Badge tone={tone}>{riskLabel(pool.perfil_riesgo)}</Badge><Badge>{statusLabel(pool.estado)}</Badge></div>
          <h3>{pool.nombre}</h3>
          <p>{pool.sectores.map((sector) => sectorLabels[sector] || sector).join(" · ")}</p>
        </div>
      </header>
      <div className="pool-card__metrics">
        <div><CalendarDays size={17} /><span><small>Plazo</small><strong>{pool.plazo_dias} días</strong></span></div>
        <div><ShieldCheck size={17} /><span><small>Objetivo</small><strong>{compactMoney(pool.capital_objetivo, pool.moneda)}</strong></span></div>
      </div>
      <div className="pool-card__progress">
        <div><span>Financiamiento</span><strong>{Number(pool.avance_pct).toFixed(0)}%</strong></div>
        <Progress value={pool.avance_pct} tone={pool.estado === "fondeado" ? "green" : "blue"} label={`${pool.avance_pct}% financiado`} />
        <small>{compactMoney(pool.capital_comprometido, pool.moneda)} comprometidos</small>
      </div>
      <Link className="pool-card__link" to={`/pools/${pool.id}`}>Ver oportunidad <ArrowRight size={17} /></Link>
    </article>
  );
}
