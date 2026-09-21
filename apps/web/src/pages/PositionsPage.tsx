import { ArrowRight, BriefcaseBusiness, ExternalLink, PieChart as PieIcon, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Badge, EmptyState, ErrorState, Panel, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { date, money, number, statusLabel, trancheLabel } from "../lib/format";
import type { Currency, Position } from "../types/domain";

const COLORS = ["#15b8a6", "#ffcc32", "#3f8cff", "#7a65d1", "#ff8064"];

export function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setPositions(await api.positions()); }
    catch (cause) { setError(normalizeError(cause).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => positions.reduce<Record<Currency, number>>((acc, position) => { acc[position.moneda] += Number(position.monto_nominal); return acc; }, { PEN: 0, USD: 0 }), [positions]);
  const allocationGroups = useMemo(() => (["PEN", "USD"] as Currency[]).map((currency) => {
    const byPool = positions.filter((position) => position.moneda === currency).reduce<Record<string, number>>((acc, position) => { acc[position.pool_nombre] = (acc[position.pool_nombre] || 0) + Number(position.monto_nominal); return acc; }, {});
    return { currency, data: Object.entries(byPool).map(([name, value]) => ({ name, value })) };
  }).filter((group) => group.data.length), [positions]);
  const uniquePools = useMemo(() => new Set(positions.map((position) => position.pool_id)).size, [positions]);

  if (loading) return <Spinner label="Cargando tus posiciones" />;
  if (error) return <ErrorState message={error} retry={() => void load()} />;

  return <div className="page-stack"><header className="page-heading"><div><p className="eyebrow">PORTAFOLIO</p><h1>Mis posiciones</h1><p>Consulta tus aportes confirmados y su registro en Stellar Testnet.</p></div></header>
    {!positions.length ? <EmptyState title="Aún no tienes posiciones" description="Explora los pools abiertos y realiza tu primer aporte." action={<Link className="button button--primary button--md" to="/pools">Explorar oportunidades <ArrowRight size={17} /></Link>} /> : <>
      <section className="position-summary-grid"><Panel><span className="panel-icon panel-icon--blue"><BriefcaseBusiness size={20} /></span><p>Total en soles</p><strong>{money(totals.PEN, "PEN")}</strong><small>Capital nominal confirmado</small></Panel><Panel><span className="panel-icon panel-icon--green"><TrendingUp size={20} /></span><p>Total en dólares</p><strong>{money(totals.USD, "USD")}</strong><small>Capital nominal confirmado</small></Panel><Panel><span className="panel-icon panel-icon--yellow"><PieIcon size={20} /></span><p>Posiciones activas</p><strong>{positions.length}</strong><small>En {uniquePools} {uniquePools === 1 ? "pool" : "pools"}</small></Panel></section>
      <section className="positions-layout"><Panel className="allocation-panel"><div className="panel-heading"><div><p>Distribución por pool</p><small>Cada moneda se analiza por separado</small></div></div><div className="allocation-groups">{allocationGroups.map((group) => <div className="allocation-group" key={group.currency}><h3>{group.currency === "PEN" ? "Soles" : "Dólares"}</h3><div className="allocation-chart" role="img" aria-label={`Distribución de posiciones en ${group.currency === "PEN" ? "soles" : "dólares"}`}><ResponsiveContainer width="100%" height={200}><PieChart><Pie data={group.data} dataKey="value" nameKey="name" innerRadius={54} outerRadius={78} paddingAngle={3} stroke="none">{group.data.map((entry, index) => <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip formatter={(value) => money(Number(value), group.currency)} /></PieChart></ResponsiveContainer><div className="allocation-chart__center"><strong>{group.data.length}</strong><span>{group.data.length === 1 ? "pool" : "pools"}</span></div></div><div className="chart-legend">{group.data.map((item, index) => <div key={item.name}><span style={{ backgroundColor: COLORS[index % COLORS.length] }} /><p>{item.name}</p><strong>{money(item.value, group.currency)}</strong></div>)}</div></div>)}</div></Panel>
        <section className="positions-list"><div className="section-heading"><div><h2>Detalle de posiciones</h2><p>Solo se muestran aportes confirmados.</p></div></div>{positions.map((position) => <article className="position-row" key={position.aporte_id}><div className={`position-row__mark position-row__mark--${position.tramo_tipo}`}>{position.pool_nombre.slice(0, 1)}</div><div className="position-row__main"><div><h3>{position.pool_nombre}</h3><div><Badge tone={position.tramo_tipo === "senior" ? "blue" : "warning"}>Tramo {trancheLabel(position.tramo_tipo)}</Badge><Badge>{statusLabel(position.pool_estado)}</Badge></div></div><div className="position-row__metrics"><span><small>Aporte</small><strong>{money(position.monto_nominal, position.moneda)}</strong></span><span><small>Pagado</small><strong>{number(position.xlm_pagados, 4)} XLM</strong></span><span><small>Confirmado</small><strong>{date(position.confirmado_at)}</strong></span></div></div><Link className="icon-button" to={`/pools/${position.pool_id}`} aria-label="Ver pool"><ExternalLink size={18} /></Link></article>)}</section></section>
    </>}
  </div>;
}
