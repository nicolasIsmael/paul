type BrandProps = {
  compact?: boolean;
  inverse?: boolean;
};

export function Brand({ compact = false, inverse = false }: BrandProps) {
  return (
    <div className={`brand ${compact ? "brand--compact" : ""} ${inverse ? "brand--inverse" : ""}`}>
      <span className="brand__mark" aria-hidden="true">
        <img src="/paul-logo.png" alt="" />
      </span>
      <span className="brand__text">
        <strong>PAUL</strong>
        {!compact && <small>Fracciona. Invierte. Conecta.</small>}
      </span>
    </div>
  );
}
