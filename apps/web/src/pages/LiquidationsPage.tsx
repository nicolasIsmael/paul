import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  ExternalLink,
  FileCheck2,
  RefreshCw,
  RotateCcw,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, Modal, Notice, Panel, Progress, Spinner } from "../components/ui";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import { date, money, shortKey, trancheLabel } from "../lib/format";
import type {
  ApiErrorShape,
  CollectionStatus,
  LiquidationResult,
  LiquidationTranche,
  OperatorInvoice,
} from "../types/domain";

const collectionLabels: Record<CollectionStatus, string> = {
  pendiente: "Pendiente",
  cobrada: "Cobrada",
  en_mora: "En mora",
};

const stateLabels = {
  activo: "Pendiente",
  liquidando: "En proceso",
  liquidado: "Liquidado",
};

const reasonLabels: Record<string, string> = {
  sin_wallet_publica: "La wallet del inversionista todavía no está lista",
  fallo_lectura_balance: "No se pudo consultar el balance on-chain",
  balance_onchain_invalido: "El balance on-chain fue inválido",
  sin_secreto_wallet: "La wallet del inversionista no está disponible",
  fallo_pago_xlm: "Falló el pago en XLM",
  fallo_quema_onchain: "La quema falló y el pago fue revertido",
  fallo_quema_onchain_y_reembolso: "Requiere reconciliación manual",
};

function attemptStorageKey(trancheId: string) {
  return `paul:liquidacion:${trancheId}`;
}

export function LiquidationsPage() {
  const { session } = useAuth();
  const [tranches, setTranches] = useState<LiquidationTranche[]>([]);
  const [invoices, setInvoices] = useState<OperatorInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [updatingInvoice, setUpdatingInvoice] = useState<string | null>(null);
  const [selected, setSelected] = useState<LiquidationTranche | null>(null);
  const [processing, setProcessing] = useState(false);
  const [liquidationError, setLiquidationError] = useState<ApiErrorShape | null>(null);
  const [result, setResult] = useState<LiquidationResult | null>(null);

  const load = useCallback(async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true);
    setLoadError("");
    try {
      const [nextTranches, nextInvoices] = await Promise.all([
        api.liquidationTranches(),
        api.operatorInvoices(),
      ]);
      setTranches(nextTranches);
      setInvoices(nextInvoices);
      if (manual) setStatus("Bandeja actualizada con el estado más reciente.");
    } catch (error) {
      setLoadError(normalizeError(error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => ({
    ready: tranches.filter((item) => item.estado_liquidacion === "activo" && item.facturas_pendientes === 0 && item.facturas_en_mora === 0).length,
    inProgress: tranches.filter((item) => item.estado_liquidacion === "liquidando").length,
    completed: tranches.filter((item) => item.estado_liquidacion === "liquidado").length,
  }), [tranches]);

  async function updateInvoice(invoice: OperatorInvoice, nextStatus: CollectionStatus) {
    if (invoice.estado_cobro === nextStatus) return;
    setUpdatingInvoice(invoice.id);
    setStatus("");
    try {
      await api.updateInvoiceCollection(invoice.id, nextStatus);
      setInvoices((current) => current.map((item) => item.id === invoice.id ? { ...item, estado_cobro: nextStatus } : item));
      setTranches((current) => current.map((item) => {
        if (item.tramo_id !== invoice.tramo_id) return item;
        const delta = (statusName: CollectionStatus) => Number(nextStatus === statusName) - Number(invoice.estado_cobro === statusName);
        return {
          ...item,
          facturas_cobradas: item.facturas_cobradas + delta("cobrada"),
          facturas_pendientes: item.facturas_pendientes + delta("pendiente"),
          facturas_en_mora: item.facturas_en_mora + delta("en_mora"),
        };
      }));
      setStatus(`Factura de ${invoice.deudor_nombre} marcada como ${collectionLabels[nextStatus].toLowerCase()}.`);
    } catch (error) {
      setStatus("");
      setLoadError(normalizeError(error).message);
    } finally {
      setUpdatingInvoice(null);
    }
  }

  function openLiquidation(tranche: LiquidationTranche) {
    setSelected(tranche);
    setLiquidationError(null);
  }

  function closeLiquidation() {
    if (processing) return;
    setSelected(null);
    setLiquidationError(null);
  }

  async function liquidate() {
    if (!selected || !session) return;
    setProcessing(true);
    setLiquidationError(null);
    const key = attemptStorageKey(selected.tramo_id);
    const idempotencyKey = localStorage.getItem(key) || crypto.randomUUID();
    localStorage.setItem(key, idempotencyKey);
    try {
      const nextResult = await api.liquidateTranche(session, selected.tramo_id, idempotencyKey);
      localStorage.removeItem(key);
      setSelected(null);
      setResult(nextResult);
      await load();
    } catch (error) {
      setLiquidationError(normalizeError(error));
    } finally {
      setProcessing(false);
    }
  }

  if (loading) return <Spinner label="Preparando la bandeja de liquidaciones" />;
  if (loadError && !tranches.length) return <ErrorState message={loadError} retry={() => void load()} />;

  return (
    <div className="page-stack liquidation-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">OPERACIÓN DE CARTERA</p>
          <h1>Liquidación de tramos</h1>
          <p>Confirma los cobros y cierra cada tramo con trazabilidad en Stellar Testnet.</p>
        </div>
        <Button variant="secondary" onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={refreshing ? "spin" : ""} size={17} />
          {refreshing ? "Actualizando" : "Actualizar"}
        </Button>
      </header>

      {status && <Notice tone="success">{status}</Notice>}
      {loadError && <ErrorState message={loadError} retry={() => void load()} />}

      <section className="liquidation-summary" aria-label="Resumen de liquidaciones">
        <Panel><span className="panel-icon panel-icon--yellow"><FileCheck2 size={19} /></span><div><strong>{summary.ready}</strong><span>Listos para liquidar</span></div></Panel>
        <Panel><span className="panel-icon panel-icon--blue"><RotateCcw size={19} /></span><div><strong>{summary.inProgress}</strong><span>Por reanudar</span></div></Panel>
        <Panel><span className="panel-icon panel-icon--green"><CheckCircle2 size={19} /></span><div><strong>{summary.completed}</strong><span>Liquidados</span></div></Panel>
      </section>

      <Notice>
        La liquidación paga XLM desde la custodia del pool y quema las fracciones del inversionista. Esta operación no se puede deshacer.
      </Notice>

      {!tranches.length ? (
        <EmptyState title="No hay tramos disponibles" description="Los tramos aparecerán aquí cuando existan pools configurados." />
      ) : (
        <section className="liquidation-list" aria-label="Tramos">
          {tranches.map((tranche) => {
            const trancheInvoices = invoices.filter((invoice) => invoice.tramo_id === tranche.tramo_id);
            const collectionPct = tranche.facturas_total ? (tranche.facturas_cobradas / tranche.facturas_total) * 100 : 100;
            const hasBlockingInvoices = tranche.facturas_pendientes > 0 || tranche.facturas_en_mora > 0;
            const missingContract = tranche.inversionistas_total > 0 && !tranche.token_contract_id;
            const canLiquidate = tranche.estado_liquidacion !== "liquidado" && !hasBlockingInvoices && !missingContract;
            return (
              <Panel className="liquidation-card" key={tranche.tramo_id}>
                <div className="liquidation-card__header">
                  <div>
                    <div className="liquidation-card__badges">
                      <Badge tone={tranche.tramo_tipo === "senior" ? "blue" : "warning"}>{trancheLabel(tranche.tramo_tipo)}</Badge>
                      <Badge tone={tranche.estado_liquidacion === "liquidado" ? "success" : tranche.estado_liquidacion === "liquidando" ? "warning" : "neutral"}>{stateLabels[tranche.estado_liquidacion]}</Badge>
                    </div>
                    <h2>{tranche.pool_nombre}</h2>
                    <p>{money(tranche.capital_comprometido, tranche.moneda)} comprometidos · {tranche.rendimiento_pct}% de rendimiento ilustrativo</p>
                  </div>
                  <Button
                    onClick={() => openLiquidation(tranche)}
                    disabled={!canLiquidate}
                    variant={tranche.estado_liquidacion === "liquidando" ? "secondary" : "primary"}
                  >
                    {tranche.estado_liquidacion === "liquidando" ? <RotateCcw size={17} /> : <CircleDollarSign size={17} />}
                    {tranche.estado_liquidacion === "liquidando" ? "Reanudar" : tranche.estado_liquidacion === "liquidado" ? "Liquidado" : "Liquidar tramo"}
                  </Button>
                </div>

                <div className="liquidation-card__metrics">
                  <div><FileCheck2 size={17} /><span><strong>{tranche.facturas_cobradas} de {tranche.facturas_total}</strong><small>Facturas cobradas</small></span></div>
                  <div><UsersRound size={17} /><span><strong>{tranche.inversionistas_total}</strong><small>Inversionistas</small></span></div>
                  <div><CircleDollarSign size={17} /><span><strong>{tranche.resultados_pagados}</strong><small>Pagos registrados</small></span></div>
                </div>

                <div className="liquidation-card__progress">
                  <div><span>Avance de cobranza</span><strong>{Math.round(collectionPct)}%</strong></div>
                  <Progress value={collectionPct} tone={collectionPct === 100 ? "green" : "yellow"} label={`Cobranza de ${tranche.pool_nombre}`} />
                </div>

                {hasBlockingInvoices && <Notice tone="warning">Marca todas las facturas como cobradas antes de liquidar este tramo.</Notice>}
                {missingContract && <Notice tone="warning">El contrato de fracciones aún no está disponible para este tramo.</Notice>}

                <div className="invoice-list">
                  <div className="invoice-list__heading"><h3>Facturas asignadas</h3><span>{trancheInvoices.length}</span></div>
                  {!trancheInvoices.length ? (
                    <p className="invoice-list__empty">Sin facturas asignadas. El cierre administrativo está permitido por el spec.</p>
                  ) : trancheInvoices.map((invoice) => (
                    <article className="invoice-row" key={invoice.id}>
                      <div className="invoice-row__main">
                        <strong>{invoice.deudor_nombre}</strong>
                        <span>{invoice.proveedor_nombre} · Vence {date(invoice.fecha_vencimiento)}</span>
                      </div>
                      <strong className="invoice-row__amount">{money(invoice.monto_nominal, invoice.moneda)}</strong>
                      <label className="invoice-status">
                        <span className="sr-only">Estado de cobro</span>
                        <select
                          value={invoice.estado_cobro}
                          disabled={updatingInvoice === invoice.id || tranche.estado_liquidacion !== "activo"}
                          onChange={(event) => void updateInvoice(invoice, event.target.value as CollectionStatus)}
                        >
                          <option value="pendiente">Pendiente</option>
                          <option value="cobrada">Cobrada</option>
                          <option value="en_mora">En mora</option>
                        </select>
                      </label>
                    </article>
                  ))}
                </div>
              </Panel>
            );
          })}
        </section>
      )}

      <Modal
        open={Boolean(selected)}
        title={processing ? "Procesando en Stellar" : "Confirmar liquidación"}
        description={selected ? `${selected.pool_nombre} · Tramo ${trancheLabel(selected.tramo_tipo)}` : undefined}
        onClose={closeLiquidation}
        dismissible={!processing}
        className={processing ? "liquidation-modal liquidation-modal--processing" : "liquidation-modal"}
      >
        {processing ? (
          <div className="processing-state">
            <span className="processing-state__rings"><span /><span /><img src="/paul-logo.png" alt="" /></span>
            <h3>Pagando y quemando fracciones</h3>
            <p>Estamos procesando a cada inversionista. No cierres esta ventana.</p>
          </div>
        ) : selected && (
          <div className="liquidation-confirm">
            <div className="liquidation-confirm__summary">
              <span><small>Capital</small><strong>{money(selected.capital_comprometido, selected.moneda)}</strong></span>
              <span><small>Inversionistas</small><strong>{selected.inversionistas_total}</strong></span>
              <span><small>Contrato</small><strong>{shortKey(selected.token_contract_id)}</strong></span>
            </div>
            <Notice tone="warning"><strong>Acción irreversible.</strong> Se enviarán pagos reales en Testnet y se quemarán las fracciones on-chain.</Notice>
            {liquidationError && <div className="liquidation-error" role="alert"><AlertTriangle size={18} /><div><strong>No se completó la liquidación</strong><p>{liquidationError.message}</p></div></div>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={closeLiquidation}>Cancelar</Button>
              <Button onClick={() => void liquidate()}>{selected.estado_liquidacion === "liquidando" ? "Reanudar liquidación" : "Confirmar liquidación"}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(result)}
        title="Liquidación completada"
        description="El tramo quedó cerrado y los resultados fueron registrados."
        onClose={() => setResult(null)}
      >
        {result && (
          <div className="liquidation-result">
            <Notice tone="success">Se procesaron {result.resultados.length} inversionistas correctamente.</Notice>
            {result.resultados.map((item, index) => (
              <div className="liquidation-result__row" key={item.investor_id}>
                <span className={item.estado === "pagado" ? "result-mark result-mark--success" : "result-mark result-mark--warning"}>{index + 1}</span>
                <div><strong>{item.estado === "pagado" ? "Pago confirmado" : "Operación compensada"}</strong><small>{item.motivo ? reasonLabels[item.motivo] || item.motivo : `${item.fracciones} fracciones procesadas`}</small></div>
                {item.tx_hash_pago && <a href={`https://stellar.expert/explorer/testnet/tx/${item.tx_hash_pago}`} target="_blank" rel="noreferrer" aria-label="Ver transacción en Stellar Expert"><ExternalLink size={17} /></a>}
              </div>
            ))}
            {!result.resultados.length && <p className="invoice-list__empty">El tramo no tenía aportes pendientes y se cerró administrativamente.</p>}
            <Button onClick={() => setResult(null)}>Cerrar</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
