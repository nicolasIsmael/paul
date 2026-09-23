import {
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  Copy,
  ExternalLink,
  Plus,
  RefreshCw,
  Sparkles,
  Wallet,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PoolCard } from "../components/PoolCard";
import { Badge, Button, CardGridSkeleton, EmptyState, ErrorState, Modal, Notice, Panel, Skeleton } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { copyText, dateTime, money, number, shortKey } from "../lib/format";
import type { ApiErrorShape, Balance, Currency, Pool, Position, TopUpResult } from "../types/domain";

const defaultFilters = {
  moneda: "" as const,
  plazo: null,
  riesgo: "" as const,
  sector: "",
  estado: "abierto" as const,
  orden: "avance_desc" as const,
};

export function DashboardPage() {
  const { profile, session } = useAuth();
  const isInvestor = profile?.rol === "inversionista";
  const [pools, setPools] = useState<Pool[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [stellarBalance, setStellarBalance] = useState<number | null>(null);
  const walletPublicKey = profile?.wallet_public_key ?? null;

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError("");
    setStatus("");
    try {
      if (isInvestor) {
        const [nextPools, nextBalances, nextPositions, nextStellarBalance] = await Promise.all([
          api.pools(defaultFilters),
          api.balances(),
          api.positions(),
          api.stellarBalance(walletPublicKey),
        ]);
        setPools(nextPools);
        setBalances(nextBalances);
        setPositions(nextPositions);
        setStellarBalance(nextStellarBalance);
      } else {
        setPools(await api.pools(defaultFilters));
      }
      if (manual) setStatus("Resumen actualizado con los datos más recientes.");
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isInvestor, walletPublicKey]);

  useEffect(() => { void load(); }, [load]);

  const totalByCurrency = useMemo(() => positions.reduce<Record<Currency, number>>((totals, position) => {
    totals[position.moneda] += Number(position.monto_nominal);
    return totals;
  }, { PEN: 0, USD: 0 }), [positions]);

  async function copyWallet() {
    if (!profile?.wallet_public_key) return;
    try {
      await copyText(profile.wallet_public_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("No pudimos copiar la dirección. Selecciónala manualmente desde tu perfil.");
    }
  }

  if (loading) return <DashboardSkeleton />;
  if (error) return <ErrorState message={error} retry={() => void load()} />;

  return (
    <div className="page-stack">
      <header className="page-heading page-heading--welcome">
        <div><p className="eyebrow">{isInvestor ? "TU PORTAFOLIO" : "VISTA DE OPERACIÓN"}</p><h1>Hola, {profile?.nombre_completo.split(" ")[0]}</h1><p>{isInvestor ? "Así se ven tus inversiones y oportunidades hoy." : "Consulta el estado agregado de los pools disponibles."}</p></div>
        <Button variant="secondary" onClick={() => void load(true)} disabled={refreshing} aria-busy={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={17} /> {refreshing ? "Actualizando" : "Actualizar"}</Button>
      </header>

      {status && <Notice tone="success">{status}</Notice>}

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
              <div className="wallet-balance"><span>Saldo real Testnet</span><strong>{stellarBalance === null ? "No disponible" : `${number(stellarBalance, 4)} XLM`}</strong></div>
              <div className="wallet-network"><span className="network-dot" /><span>Stellar Testnet</span><small>Las llaves privadas nunca salen del backend</small></div>
              {profile?.wallet_public_key && <a className="wallet-explorer-link" href={`https://stellar.expert/explorer/testnet/account/${profile.wallet_public_key}?filter=all`} target="_blank" rel="noreferrer">Ver actividad en Stellar Expert <ExternalLink size={14} /></a>}
            </Panel>
          </section>
        </>
      )}

      <section className="section-stack">
        <div className="section-heading"><div><p className="eyebrow">OPORTUNIDADES</p><h2>{isInvestor ? "Pools destacados" : "Pools disponibles"}</h2></div><Link className="text-link" to="/pools">Ver todos <ArrowRight size={16} /></Link></div>
        {pools.length ? <div className="pool-grid">{pools.slice(0, 3).map((pool) => <PoolCard key={pool.id} pool={pool} />)}</div> : <EmptyState title="No hay pools abiertos" description="Vuelve más tarde para explorar nuevas oportunidades." />}
      </section>

      <TopUpModal open={topUpOpen} session={session} onClose={() => setTopUpOpen(false)} onSuccess={(result) => { setStellarBalance(result.balance_xlm); void load(true); }} />
    </div>
  );
}

function TopUpModal({ open, session, onClose, onSuccess }: { open: boolean; session: Session | null; onClose: () => void; onSuccess: (result: TopUpResult) => void }) {
  const [currency, setCurrency] = useState<Currency>("PEN");
  const [amount, setAmount] = useState("200");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorShape | null>(null);
  const [result, setResult] = useState<TopUpResult | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  function beginNewIntent() {
    idempotencyKey.current = crypto.randomUUID();
    setError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!session) throw { code: "PA008", message: "Tu sesión expiró. Inicia sesión nuevamente." };
      const nextResult = await api.topUp(session, currency, Number(amount), idempotencyKey.current);
      setResult(nextResult);
      onSuccess(nextResult);
    } catch (cause) {
      setError(normalizeError(cause));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setResult(null);
    setError(null);
    idempotencyKey.current = crypto.randomUUID();
    onClose();
  }

  return (
    <Modal open={open} title={result ? "Recarga exitosa" : "Recargar saldo demo"} description={result ? "El XLM ya llegó a tu wallet de Stellar Testnet." : "Recibe XLM de prueba y el crédito equivalente para realizar aportes."} onClose={close} dismissible={!busy}>
      {result ? (
        <div className="success-block"><span><CheckCircle2 size={28} /></span><h3>{number(result.monto_xlm, 4)} XLM</h3><p>{result.simulado ? "Recarga simulada en la vista previa" : "Recibidos en tu wallet de Testnet"}</p><div className="result-row"><span>Saldo XLM actual</span><strong>{result.balance_xlm === null ? "Consultando" : `${number(result.balance_xlm, 4)} XLM`}</strong></div><div className="result-row"><span>Saldo demo en {result.moneda}</span><strong>{money(result.saldo_actualizado, result.moneda)}</strong></div><div className="result-row"><span>Disponible para recargar hoy</span><strong>{money(result.disponible_para_recargar_hoy, "PEN")}</strong></div><div className="result-row"><span>El límite se reinicia</span><strong>{dateTime(result.se_reinicia_at)}</strong></div>{result.tx_hash && !result.simulado && <a className="stellar-link" href={`https://stellar.expert/explorer/testnet/tx/${result.tx_hash}`} target="_blank" rel="noreferrer">Ver transacción en Stellar Expert <ExternalLink size={16} /></a>}<Button onClick={close}>Listo</Button></div>
      ) : (
        <form className="modal-form" onSubmit={submit}>
          <div className="segmented-control"><button type="button" className={currency === "PEN" ? "active" : ""} disabled={busy} onClick={() => { setCurrency("PEN"); beginNewIntent(); }}>Soles</button><button type="button" className={currency === "USD" ? "active" : ""} disabled={busy} onClick={() => { setCurrency("USD"); beginNewIntent(); }}>Dólares</button></div>
          <label className="field"><span>Monto a recargar</span><div className="amount-input"><span>{currency === "PEN" ? "S/" : "US$"}</span><input data-modal-autofocus type="number" min="1" step="1" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); beginNewIntent(); }} required /></div></label>
          <div className="quick-amounts">{[100, 200, 500].map((value) => <button type="button" key={value} disabled={busy} onClick={() => { setAmount(String(value)); beginNewIntent(); }}>+ {value}</button>)}</div>
          <p className="form-help">Tope diario compartido: S/1,000 o equivalente. El XLM se enviará a tu wallet en Stellar Testnet.</p>
          {error && <Notice tone="warning"><strong>{error.message}</strong>{error.disponible_para_recargar_hoy !== undefined && <span className="notice__detail">Disponible hoy: {money(error.disponible_para_recargar_hoy, "PEN")}</span>}{error.se_reinicia_at && <span className="notice__detail">El límite se reinicia {dateTime(error.se_reinicia_at)}</span>}<small className="notice__code">Referencia: {error.code}</small></Notice>}
          <Button type="submit" size="lg" disabled={busy || Number(amount) <= 0}>{busy ? "Recargando..." : "Confirmar recarga"}</Button>
        </form>
      )}
    </Modal>
  );
}

function DashboardSkeleton() {
  return (
    <div className="page-stack" role="status" aria-label="Cargando tu resumen">
      <div className="skeleton-heading"><div><Skeleton className="skeleton-heading__eyebrow" /><Skeleton className="skeleton-heading__title" /><Skeleton className="skeleton-heading__copy" /></div></div>
      <section className="summary-grid">
        {Array.from({ length: 3 }, (_, index) => <div className="skeleton-card skeleton-card--summary" key={index}><Skeleton className="skeleton-card__title" /><Skeleton className="skeleton-card__block" /><Skeleton className="skeleton-card__line" /></div>)}
      </section>
      <CardGridSkeleton />
    </div>
  );
}
