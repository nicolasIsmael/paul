import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  ExternalLink,
  Layers3,
  ShieldCheck,
  Timer,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, ErrorState, Modal, Notice, Panel, Progress, Spinner } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { compactMoney, date, money, number, riskLabel, statusLabel, trancheLabel } from "../lib/format";
import type { ApiErrorShape, ContributionResult, PoolDetail, Quote, TrancheType } from "../types/domain";

type InvestmentStep = "amount" | "quote" | "processing" | "success";

export function PoolDetailPage() {
  const { poolId = "" } = useParams();
  const { profile, session } = useAuth();
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedTranche, setSelectedTranche] = useState<TrancheType>("senior");
  const [investOpen, setInvestOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setDetail(await api.poolDetail(poolId)); }
    catch (cause) { setError(normalizeError(cause).message); }
    finally { setLoading(false); }
  }, [poolId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spinner label="Cargando oportunidad" />;
  if (error || !detail) return <ErrorState message={error || "No encontramos este pool."} retry={() => void load()} />;

  const canInvest = profile?.rol === "inversionista" && detail.estado === "abierto" && Boolean(profile.wallet_public_key);

  return (
    <div className="page-stack">
      <Link className="back-link" to="/pools"><ArrowLeft size={17} /> Volver a oportunidades</Link>
      <header className="detail-hero">
        <div className="detail-hero__copy"><div className="pool-card__badges"><Badge tone={detail.perfil_riesgo === "conservador" ? "success" : detail.perfil_riesgo === "agresivo" ? "warning" : "blue"}>{riskLabel(detail.perfil_riesgo)}</Badge><Badge>{statusLabel(detail.estado)}</Badge></div><h1>{detail.nombre}</h1><p>{detail.descripcion_corta}</p><div className="detail-hero__facts"><span><CalendarDays size={17} /> {detail.plazo_dias} días</span><span><Timer size={17} /> Vence {date(detail.fecha_vencimiento_esperada)}</span><span><Layers3 size={17} /> {detail.composicion.sectores.join(" · ")}</span></div></div>
        <div className="detail-hero__aside"><span>Capital objetivo</span><strong>{compactMoney(detail.tramos.senior.capital_objetivo + detail.tramos.junior.capital_objetivo, detail.moneda)}</strong><small>{detail.moneda === "PEN" ? "Soles peruanos" : "Dólares estadounidenses"}</small></div>
      </header>

      <section className="detail-layout">
        <div className="detail-main">
          <section className="section-stack"><div className="section-heading"><div><p className="eyebrow">ELIGE TU PERFIL</p><h2>Compara los tramos</h2></div></div><div className="tranche-grid">{(["senior", "junior"] as TrancheType[]).map((tranche) => <TrancheCard key={tranche} type={tranche} detail={detail} selected={selectedTranche === tranche} onSelect={() => setSelectedTranche(tranche)} />)}</div></section>

          <Panel className="composition-panel"><div className="section-heading"><div><p className="eyebrow">COMPOSICIÓN AGREGADA</p><h2>Diversificación del pool</h2></div><Badge tone="success"><ShieldCheck size={14} /> Datos protegidos</Badge></div><div className="composition-grid"><Metric icon={<Building2 size={20} />} label="Operaciones" value={detail.composicion.numero_operaciones} /><Metric icon={<UsersRound size={20} />} label="Empresas pagadoras" value={detail.composicion.numero_empresas} /><Metric icon={<Layers3 size={20} />} label="Sectores" value={detail.composicion.sectores.length} /><Metric icon={<TrendingUp size={20} />} label="Concentración máxima" value={`${detail.composicion.concentracion_maxima_pct}%`} /></div><p className="panel-footnote">PAUL muestra datos agregados para proteger la identidad de cada operación y empresa.</p></Panel>

          <Panel className="risk-explainer"><div><span className="panel-icon panel-icon--yellow"><ShieldCheck size={21} /></span><div><h3>¿Cómo se protege el tramo senior?</h3><p>{detail.comparacion_tramos.senior}</p></div></div><div className="junior-cushion"><span>Colchón junior</span><strong>{detail.colchon_junior_pct}%</strong><Progress value={detail.colchon_junior_pct} tone="yellow" /></div></Panel>
        </div>

        <aside className="investment-summary">
          <Panel><p className="eyebrow">TU SELECCIÓN</p><h3>Tramo {trancheLabel(selectedTranche)}</h3><div className="investment-summary__yield"><span>Rendimiento ilustrativo</span><strong>{detail.tramos[selectedTranche].rendimiento_ilustrativo_plazo_pct}%</strong><small>durante el plazo · {detail.tramos[selectedTranche].rendimiento_ilustrativo_anualizado_pct}% anualizado</small></div><div className="result-row"><span>Aporte mínimo</span><strong>{money(detail.aporte_minimo.monto, detail.moneda)}</strong></div>{detail.aporte_minimo.equivalente_xlm !== null && <div className="result-row"><span>Equivalente estimado</span><strong>{number(detail.aporte_minimo.equivalente_xlm, 4)} XLM</strong></div>}<div className="result-row"><span>Cupo disponible</span><strong>{money(detail.tramos[selectedTranche].cupo_disponible, detail.moneda)}</strong></div><Button size="lg" onClick={() => setInvestOpen(true)} disabled={!canInvest}>{detail.estado !== "abierto" ? "Pool no disponible" : profile?.rol !== "inversionista" ? "Solo para inversionistas" : !profile.wallet_public_key ? "Wallet en preparación" : <>Realizar aporte <ArrowRight size={18} /></>}</Button><p className="investment-disclaimer">{detail.disclaimer_rendimiento}</p></Panel>
        </aside>
      </section>

      <InvestmentModal open={investOpen} onClose={() => setInvestOpen(false)} detail={detail} initialTranche={selectedTranche} session={session} onSuccess={() => void load()} />
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return <div className="composition-metric"><span>{icon}</span><div><strong>{value}</strong><small>{label}</small></div></div>;
}

function TrancheCard({ type, detail, selected, onSelect }: { type: TrancheType; detail: PoolDetail; selected: boolean; onSelect: () => void }) {
  const tranche = detail.tramos[type];
  return <button className={`tranche-card tranche-card--${type} ${selected ? "tranche-card--selected" : ""}`} onClick={onSelect}><div className="tranche-card__top"><span className="tranche-symbol">{type === "senior" ? <ShieldCheck size={22} /> : <TrendingUp size={22} />}</span><div><h3>Tramo {trancheLabel(type)}</h3><p>{type === "senior" ? "Prioridad de cobro y menor riesgo" : "Mayor potencial y mayor exposición"}</p></div><span className="radio-indicator" /></div><div className="tranche-card__numbers"><div><span>Rendimiento plazo</span><strong>{tranche.rendimiento_ilustrativo_plazo_pct}%</strong></div><div><span>Cupo disponible</span><strong>{compactMoney(tranche.cupo_disponible, detail.moneda)}</strong></div></div><div className="tranche-card__progress"><span>{tranche.avance_pct}% financiado</span><Progress value={tranche.avance_pct} tone={type === "senior" ? "blue" : "yellow"} /></div></button>;
}

function InvestmentModal({ open, onClose, detail, initialTranche, session, onSuccess }: { open: boolean; onClose: () => void; detail: PoolDetail; initialTranche: TrancheType; session: ReturnType<typeof useAuth>["session"]; onSuccess: () => void }) {
  const [step, setStep] = useState<InvestmentStep>("amount");
  const [tranche, setTranche] = useState<TrancheType>(initialTranche);
  const [amount, setAmount] = useState(String(detail.aporte_minimo.monto));
  const [quote, setQuote] = useState<Quote | null>(null);
  const [result, setResult] = useState<ContributionResult | null>(null);
  const [error, setError] = useState<ApiErrorShape | null>(null);
  const [now, setNow] = useState(Date.now());
  const idempotencyKey = useRef(crypto.randomUUID());

  useEffect(() => { if (open) { setTranche(initialTranche); setAmount(String(detail.aporte_minimo.monto)); } }, [detail.aporte_minimo.monto, initialTranche, open]);
  useEffect(() => { if (step !== "quote") return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [step]);

  const secondsLeft = useMemo(() => quote ? Math.max(0, Math.floor((new Date(quote.expira_at).getTime() - now) / 1000)) : 0, [now, quote]);
  const isAmountValid = Number(amount) > 0 && Number(amount) % Number(detail.aporte_minimo.monto) === 0 && Number(amount) <= detail.tramos[tranche].cupo_disponible;

  function resetAndClose() { setStep("amount"); setQuote(null); setResult(null); setError(null); idempotencyKey.current = crypto.randomUUID(); onClose(); }

  async function createQuote(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    try { const nextQuote = await api.quote(detail.id, tranche, Number(amount)); setQuote(nextQuote); setNow(Date.now()); setStep("quote"); }
    catch (cause) { setError(normalizeError(cause)); }
  }

  async function confirm() {
    if (!session || !quote) return;
    if (secondsLeft <= 0) { setError({ code: "PA004", message: "La cotización expiró. Genera una nueva para continuar." }); setStep("amount"); setQuote(null); return; }
    setStep("processing"); setError(null);
    try { const confirmation = await api.confirmContribution(session, quote.cotizacion_id, idempotencyKey.current); setResult(confirmation); setStep("success"); onSuccess(); }
    catch (cause) { setError(normalizeError(cause)); setStep("quote"); }
  }

  const title = step === "success" ? "Aporte confirmado" : step === "processing" ? "Procesando en Stellar" : "Realizar un aporte";
  return <Modal open={open} title={title} description={step === "success" ? "Tu posición ya forma parte del portafolio." : detail.nombre} onClose={resetAndClose}>
    {step === "amount" && <form className="modal-form" onSubmit={(event) => void createQuote(event)}><div className="segmented-control"><button type="button" className={tranche === "senior" ? "active" : ""} onClick={() => setTranche("senior")}>Senior</button><button type="button" className={tranche === "junior" ? "active" : ""} onClick={() => setTranche("junior")}>Junior</button></div><label className="field"><span>Monto del aporte</span><div className="amount-input"><span>{detail.moneda === "PEN" ? "S/" : "US$"}</span><input type="number" min={detail.aporte_minimo.monto} step={detail.aporte_minimo.monto} max={detail.tramos[tranche].cupo_disponible} value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label><div className="input-meta"><span>Múltiplos de {money(detail.aporte_minimo.monto, detail.moneda)}</span><span>Cupo: {money(detail.tramos[tranche].cupo_disponible, detail.moneda)}</span></div>{error && <Notice tone="warning">{error.message}</Notice>}<Button size="lg" type="submit" disabled={!isAmountValid}>Obtener cotización <ArrowRight size={18} /></Button></form>}
    {step === "quote" && quote && <div className="quote-review"><div className="quote-total"><span>Tu aporte</span><strong>{money(quote.monto_nominal, quote.moneda)}</strong><small>{number(quote.monto_xlm, 4)} XLM</small></div><div className="quote-details"><div><span>Tramo</span><strong>{trancheLabel(quote.tramo_tipo)}</strong></div><div><span>Tipo de cambio</span><strong>1 XLM = {number(quote.tipo_cambio_aplicado, 4)} {quote.moneda}</strong></div><div><span>Vigencia</span><strong className={secondsLeft < 60 ? "text-warning" : ""}>{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")}</strong></div></div><Notice>{quote.tipo_cambio_nota}</Notice>{error && <Notice tone="warning">{error.message}</Notice>}<div className="modal-actions"><Button variant="secondary" onClick={() => setStep("amount")}>Editar monto</Button><Button onClick={() => void confirm()} disabled={secondsLeft <= 0}>Confirmar aporte</Button></div></div>}
    {step === "processing" && <div className="processing-state"><span className="processing-state__rings"><span /><span /><img src="/paul-logo.png" alt="" /></span><h3>Confirmando tu aporte</h3><p>Estamos reservando el cupo y registrando el pago en Stellar Testnet. No cierres esta ventana.</p></div>}
    {step === "success" && result && <div className="success-block"><span><CheckCircle2 size={29} /></span><h3>{money(result.aporte.monto_nominal, result.aporte.moneda)}</h3><p>Aporte confirmado en el tramo {trancheLabel(tranche)}</p><div className="result-row"><span>XLM pagados</span><strong>{number(result.aporte.xlm_pagados, 4)} XLM</strong></div><div className="result-row"><span>Comprobante</span><strong>{result.comprobante.simulado ? "Simulado" : "Registrado en testnet"}</strong></div>{result.comprobante.tx_hash && !result.comprobante.simulado && <a className="stellar-link" href={`https://stellar.expert/explorer/testnet/tx/${result.comprobante.tx_hash}`} target="_blank" rel="noreferrer">Ver transacción en Stellar Expert <ExternalLink size={16} /></a>}<Button onClick={resetAndClose}>Listo</Button></div>}
  </Modal>;
}
