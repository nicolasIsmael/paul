import { Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PoolCard } from "../components/PoolCard";
import { Button, EmptyState, ErrorState, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { normalizeError } from "../lib/errors";
import type { Pool, PoolFilters } from "../types/domain";

const initialFilters: PoolFilters = {
  moneda: "",
  plazo: null,
  riesgo: "",
  sector: "",
  estado: "abierto",
  orden: "avance_desc",
};

export function PoolsPage() {
  const [filters, setFilters] = useState<PoolFilters>(initialFilters);
  const [search, setSearch] = useState("");
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPools(await api.pools(filters));
    } catch (cause) {
      setError(normalizeError(cause).message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);

  const visiblePools = pools.filter((pool) => pool.nombre.toLowerCase().includes(search.toLowerCase()));
  const hasCustomFilters = JSON.stringify(filters) !== JSON.stringify(initialFilters);

  function clearFilters() {
    setFilters(initialFilters);
    setSearch("");
  }

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div><p className="eyebrow">EXPLORAR</p><h1>Oportunidades de inversión</h1><p>Compara pools por plazo, riesgo, moneda y nivel de financiamiento.</p></div>
      </header>

      <div className="catalog-toolbar">
        <label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre" /></label>
        <Button variant="secondary" className="filter-toggle" onClick={() => setFiltersOpen((open) => !open)}><SlidersHorizontal size={17} /> Filtros</Button>
        <label className="sort-field"><span>Ordenar por</span><select value={filters.orden} onChange={(event) => setFilters((current) => ({ ...current, orden: event.target.value as PoolFilters["orden"] }))}><option value="avance_desc">Mayor avance</option><option value="avance_asc">Menor avance</option><option value="monto_desc">Mayor monto</option><option value="monto_asc">Menor monto</option><option value="vencimiento_asc">Próximo vencimiento</option></select></label>
      </div>

      <div className={`filter-panel ${filtersOpen ? "filter-panel--open" : ""}`}>
        <FilterSelect label="Moneda" value={filters.moneda} onChange={(value) => setFilters((current) => ({ ...current, moneda: value as PoolFilters["moneda"] }))} options={[['', 'Todas'], ['PEN', 'Soles'], ['USD', 'Dólares']]} />
        <FilterSelect label="Plazo" value={filters.plazo?.toString() || ""} onChange={(value) => setFilters((current) => ({ ...current, plazo: value ? Number(value) : null }))} options={[['', 'Todos'], ['30', '30 días'], ['60', '60 días'], ['90', '90 días']]} />
        <FilterSelect label="Riesgo" value={filters.riesgo} onChange={(value) => setFilters((current) => ({ ...current, riesgo: value as PoolFilters["riesgo"] }))} options={[['', 'Todos'], ['conservador', 'Conservador'], ['balanceado', 'Balanceado'], ['agresivo', 'Agresivo']]} />
        <FilterSelect label="Sector" value={filters.sector} onChange={(value) => setFilters((current) => ({ ...current, sector: value }))} options={[['', 'Todos'], ['retail', 'Retail'], ['manufactura', 'Manufactura'], ['servicios', 'Servicios'], ['construccion', 'Construcción'], ['tecnologia', 'Tecnología']]} />
        <FilterSelect label="Estado" value={filters.estado} onChange={(value) => setFilters((current) => ({ ...current, estado: value as PoolFilters["estado"] }))} options={[['', 'Todos'], ['abierto', 'Abiertos'], ['fondeado', 'Fondeados'], ['cerrado', 'Cerrados']]} />
        {hasCustomFilters && <button className="clear-filters" onClick={clearFilters}><X size={15} /> Limpiar</button>}
      </div>

      <div className="catalog-meta"><p><strong>{visiblePools.length}</strong> {visiblePools.length === 1 ? "oportunidad encontrada" : "oportunidades encontradas"}</p><span>Datos agregados y protegidos</span></div>

      {loading ? <Spinner label="Buscando oportunidades" /> : error ? <ErrorState message={error} retry={() => void load()} /> : visiblePools.length ? <div className="pool-grid">{visiblePools.map((pool) => <PoolCard key={pool.id} pool={pool} />)}</div> : <EmptyState title="No encontramos resultados" description="Prueba combinando otros filtros o vuelve al catálogo completo." action={<Button variant="secondary" onClick={clearFilters}>Limpiar filtros</Button>} />}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}
