import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  Copy,
  Plus,
  RefreshCw,
  Sparkles,
  Wallet,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PoolCard } from "../components/PoolCard";
import { Badge, Button, EmptyState, ErrorState, Modal, Panel, Spinner } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { copyText, dateTime, money, shortKey } from "../lib/format";
import type { Balance, Currency, Pool, Position, TopUpResult } from "../types/domain";

const defaultFilters = {
  moneda: "" as const,
  plazo: null,
  riesgo: "" as const,
  sector: "",
  estado: "abierto" as const,
  orden: "avance_desc" as const,
};

export function DashboardPage() {
  const { profile } = useAuth();
  const isInvestor = profile?.rol === "inversionista";
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const requests: [Promise<Pool[]>, Promise<Balance[]>?, Promise<Position[]>?] = [api.pools(defaultFilters)];
      if (isInvestor) requests.push(api.balances(), api.positions());
      const [nextPools, nextBalances = [], nextPositions = []] = await Promise.all(requests);
      setPools(nextPools);
      setBalances(nextBalances);
      setPositions(nextPositions);
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setLoading(false);
    }
  }, [isInvestor]);

  useEffect(() => { void load(); }, [load]);

  const totalByCurrency = useMemo(() => positions.reduce<Record<Currency, number>>((totals, position) => {
    totals[position.moneda] += Number(position.monto_nominal);
    return totals;
  }, { PEN: 0, USD: 0 }), [positions]);

  async function copyWallet() {
    if (!profile?.wallet_public_key) return;
    await copyText(profile.wallet_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (loading) return <Spinner label="Cargando tu resumen" />;
  if (error) return <ErrorState message={error} retry={() => void load()} />;

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--welcome">
        <div><p className="eyebrow">{isInvestor ? "TU PORTAFOLIO" : "VISTA DE OPERACIÓN"}</p><h1>Hola, {profile?.nombre_completo.split(" ")[0]}</h1><p>{isInvestor ? "Así se ven tus inversiones y oportunidades hoy." : "Consulta el estado agregado de los pools disponibles."}</p></div>
        <Button variant="secondary" onClick={() => void load()}><RefreshCw size={17} /> Actualizar</Button>
      </header>

      {isInvestor && (
        <>
          {!profile?.wallet_public_key && <div className="wallet-preparing"><span><Sparkles size={20} /></span><div><strong>Estamos preparando tu wallet</strong><p>Ya puedes explorar oportunidades. Te avisaremos cuando esté lista para aportar.</p></div></div>}
          <section className="summary-grid">
            <Panel className="balance-panel">
              <div className="panel-heading"><div><span className="panel-icon panel-icon--yellow"><Wallet size={20} /></span><div><p>Saldo de demostración</p><small>Crédito para probar la plataforma</small></div></div><Button size="sm" onClick={() => setTopUpOpen(true)} disabled={!profile?.wallet_public_key}><Plus size={16} /> Recargar</Button></div>
              <div className="balance-list">
                {(["PEN", "USD"] as Currency[]).map((currency) => <div key={currency}><span>{currency === "PEN" ? "Soles" : "Dólares"}</span><strong>{money(balances.find((balance) => balance.moneda === currency)?.saldo || 0, currency)}</strong></div>)}
              </div>
              <p className="panel-footnote">Saldo contable de prueba. No representa dinero real.</p>
            </Panel>

            <Panel className="portfolio-panel">
              <div className="panel-heading"><div><span className="panel-icon panel-icon--green"><BriefcaseBusiness size={20} /></span><div><p>Capital aportado</p><small>{positions.length} {positions.length === 1 ? "posición confirmada" : "posiciones confirmadas"}</small></div></div><Link className="text-link" to="/posiciones">Ver detalle <ArrowRight size={15} /></Link></div>
              <div className="portfolio-values"><div><span>En soles</span><strong>{money(totalByCurrency.PEN, "PEN")}</strong></div><div><span>En dólares</span><strong>{money(totalByCurrency.USD, "USD")}</strong></div></div>
              <div className="mini-position-list">
                {positions.slice(0, 2).map((position) => <div key={position.aporte_id}><span className={`tranche-dot tranche-dot--${position.tramo_tipo}`} /><span><strong>{position.pool_nombre}</strong><small>{position.tramo_tipo === "senior" ? "Tramo senior" : "Tramo junior"}</small></span><b>{money(position.monto_nominal, position.moneda)}</b></div>)}
              </div>
            </Panel>

            <Panel className="wallet-panel">
              <div className="panel-heading"><div><span className="panel-icon panel-icon--blue"><Wallet size={20} /></span><div><p>Wallet Stellar</p><small>Custodiada por PAUL</small></div></div><Badge tone={profile?.wallet_public_key ? "success" : "warning"}>{profile?.wallet_public_key ? "Activa" : "Preparando"}</Badge></div>
              <div className="wallet-address"><span>{shortKey(profile?.wallet_public_key || null)}</span><button className="icon-button" onClick={() => void copyWallet()} disabled={!profile?.wallet_public_key} aria-label="Copiar dirección">{copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}</button></div>
              <div className="wallet-network"><span className="network-dot" /><span>Stellar Testnet</span><small>Las llaves privadas nunca salen del backend</small></div>
            </Panel>
          </section>
        </>
      )}

      <section className="section-stack">
        <div className="section-heading"><div><p className="eyebrow">OPORTUNIDADES</p><h2>{isInvestor ? "Pools destacados" : "Pools disponibles"}</h2></div><Link className="text-link" to="/pools">Ver todos <ArrowRight size={16} /></Link></div>
        {pools.length ? <div className="pool-grid">{pools.slice(0, 3).map((pool) => <PoolCard key={pool.id} pool={pool} />)}</div> : <EmptyState title="No hay pools abiertos" description="Vuelve más tarde para explorar nuevas oportunidades." />}
      </section>

      <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} onSuccess={() => void load()} />
    </div>
  );
}

function TopUpModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [currency, setCurrency] = useState<Currency>("PEN");
  const [amount, setAmount] = useState("200");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TopUpResult | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const nextResult = await api.topUp(currency, Number(amount));
      setResult(nextResult);
      onSuccess();
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setResult(null);
    setError("");
    onClose();
  }

  return (
    <Modal open={open} title={result ? "Recarga completada" : "Recargar saldo demo"} description={result ? "Tu saldo ya fue actualizado." : "Añade crédito contable para probar tus aportes."} onClose={close}>
      {result ? (
        <div className="success-block"><span><CheckCircle2 size={28} /></span><h3>{money(result.saldo_actualizado, result.moneda)}</h3><p>Nuevo saldo disponible</p><div className="result-row"><span>Disponible para recargar hoy</span><strong>{money(result.disponible_para_recargar_hoy, "PEN")}</strong></div><div className="result-row"><span>El límite se reinicia</span><strong>{dateTime(result.se_reinicia_at)}</strong></div><Button onClick={close}>Listo</Button></div>
      ) : (
        <form className="modal-form" onSubmit={submit}>
          <div className="segmented-control"><button type="button" className={currency === "PEN" ? "active" : ""} onClick={() => setCurrency("PEN")}>Soles</button><button type="button" className={currency === "USD" ? "active" : ""} onClick={() => setCurrency("USD")}>Dólares</button></div>
          <label className="field"><span>Monto a recargar</span><div className="amount-input"><span>{currency === "PEN" ? "S/" : "US$"}</span><input type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} required /></div></label>
          <div className="quick-amounts">{[100, 200, 500].map((value) => <button type="button" key={value} onClick={() => setAmount(String(value))}>+ {value}</button>)}</div>
          <p className="form-help">Tope diario compartido: S/1,000 o equivalente. Esta recarga no mueve XLM.</p>
          {error && <div className="inline-error">{error}</div>}
          <Button type="submit" size="lg" disabled={busy || Number(amount) <= 0}>{busy ? "Recargando..." : "Confirmar recarga"}</Button>
        </form>
      )}
    </Modal>
  );
}
