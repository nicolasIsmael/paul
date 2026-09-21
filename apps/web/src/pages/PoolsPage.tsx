import { Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PoolCard } from "../components/PoolCard";
import { Badge, Button, CardGridSkeleton, EmptyState, ErrorState } from "../components/ui";
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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pools, setPools] = useState<Pool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const nextPools = await api.pools(filters);
      if (currentRequest === requestId.current) setPools(nextPools);
    } catch (cause) {
      if (currentRequest === requestId.current) setError(normalizeError(cause).message);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const visiblePools = pools.filter((pool) => pool.nombre.toLowerCase().includes(debouncedSearch));
  const hasCustomFilters = JSON.stringify(filters) !== JSON.stringify(initialFilters);
  const activeFilterCount = [filters.moneda, filters.plazo, filters.riesgo, filters.sector, filters.estado !== "abierto" ? filters.estado : "", search.trim()].filter(Boolean).length;
  const canClear = hasCustomFilters || Boolean(search.trim());

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
        <label className="search-field"><Search size={18} /><span className="sr-only">Buscar oportunidades</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por nombre" type="search" /></label>
        <Button variant="secondary" className="filter-toggle" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} aria-controls="pool-filters"><SlidersHorizontal size={17} /> Filtros {activeFilterCount > 0 && <Badge tone="blue">{activeFilterCount}</Badge>}</Button>
        <label className="sort-field"><span>Ordenar por</span><select value={filters.orden} onChange={(event) => setFilters((current) => ({ ...current, orden: event.target.value as PoolFilters["orden"] }))}><option value="avance_desc">Mayor avance</option><option value="avance_asc">Menor avance</option><option value="monto_desc">Mayor monto</option><option value="monto_asc">Menor monto</option><option value="vencimiento_asc">Próximo vencimiento</option></select></label>
      </div>

      <div className={`filter-panel ${filtersOpen ? "filter-panel--open" : ""}`} id="pool-filters">
        <FilterSelect label="Moneda" value={filters.moneda} onChange={(value) => setFilters((current) => ({ ...current, moneda: value as PoolFilters["moneda"] }))} options={[['', 'Todas'], ['PEN', 'Soles'], ['USD', 'Dólares']]} />
        <FilterSelect label="Plazo" value={filters.plazo?.toString() || ""} onChange={(value) => setFilters((current) => ({ ...current, plazo: value ? Number(value) : null }))} options={[['', 'Todos'], ['30', '30 días'], ['60', '60 días'], ['90', '90 días']]} />
        <FilterSelect label="Riesgo" value={filters.riesgo} onChange={(value) => setFilters((current) => ({ ...current, riesgo: value as PoolFilters["riesgo"] }))} options={[['', 'Todos'], ['conservador', 'Conservador'], ['balanceado', 'Balanceado'], ['agresivo', 'Agresivo']]} />
        <FilterSelect label="Sector" value={filters.sector} onChange={(value) => setFilters((current) => ({ ...current, sector: value }))} options={[['', 'Todos'], ['retail', 'Retail'], ['manufactura', 'Manufactura'], ['servicios', 'Servicios'], ['construccion', 'Construcción'], ['tecnologia', 'Tecnología']]} />
        <FilterSelect label="Estado" value={filters.estado} onChange={(value) => setFilters((current) => ({ ...current, estado: value as PoolFilters["estado"] }))} options={[['', 'Todos'], ['abierto', 'Abiertos'], ['fondeado', 'Fondeados'], ['cerrado', 'Cerrados']]} />
        {canClear && <button className="clear-filters" onClick={clearFilters}><X size={15} /> Limpiar</button>}
      </div>

      <div className="catalog-meta" aria-live="polite"><p>{loading ? "Actualizando oportunidades..." : <><strong>{visiblePools.length}</strong> {visiblePools.length === 1 ? "oportunidad encontrada" : "oportunidades encontradas"}</>}</p><span>{activeFilterCount > 0 ? `${activeFilterCount} ${activeFilterCount === 1 ? "filtro activo" : "filtros activos"}` : "Datos agregados y protegidos"}</span></div>

      {loading ? <CardGridSkeleton count={6} /> : error ? <ErrorState message={error} retry={() => void load()} /> : visiblePools.length ? <div className="pool-grid">{visiblePools.map((pool) => <PoolCard key={pool.id} pool={pool} />)}</div> : <EmptyState title="No encontramos resultados" description="Prueba combinando otros filtros o vuelve al catálogo completo." action={<Button variant="secondary" onClick={clearFilters}>Limpiar filtros</Button>} />}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <label><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></label>;
}
