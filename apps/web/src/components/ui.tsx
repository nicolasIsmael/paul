import { AlertCircle, Check, Inbox, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button className={`button button--${variant} button--${size} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function Badge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Progress({ value, tone = "blue", label }: { value: number; tone?: string; label?: string }) {
  const safeValue = Math.max(0, Math.min(100, Number(value)));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={safeValue}>
      <span className={`progress__fill progress__fill--${tone}`} style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}

export function CardGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="pool-grid" role="status" aria-label="Cargando oportunidades">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <Skeleton className="skeleton-card__badge" />
          <Skeleton className="skeleton-card__title" />
          <Skeleton className="skeleton-card__line" />
          <Skeleton className="skeleton-card__block" />
          <Skeleton className="skeleton-card__button" />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Cargando" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <LoaderCircle size={20} />
      <span>{label}</span>
    </div>
  );
}

export function PageLoader({ label = "Preparando tu experiencia" }: { label?: string }) {
  return (
    <div className="page-loader">
      <span className="page-loader__mark"><img src="/paul-logo.png" alt="" /></span>
      <Spinner label={label} />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Inbox size={22} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={20} />
      <div><strong>No pudimos cargar esta información</strong><p>{message}</p></div>
      {retry && <Button variant="secondary" size="sm" onClick={retry}>Reintentar</Button>}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  dismissible = true,
  className = "",
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
  className?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const modalRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const modal = modalRef.current;
    const focusableSelector = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
    requestAnimationFrame(() => (modal?.querySelector<HTMLElement>("[data-modal-autofocus]") || modal?.querySelector<HTMLElement>(focusableSelector))?.focus());

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !modal) return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [dismissible, open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={() => dismissible && onClose()}>
      <section ref={modalRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>
          {dismissible && <button className="icon-button" type="button" onClick={onClose} aria-label="Cerrar"><X size={20} /></button>}
        </header>
        <div className="modal__body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "success" | "warning"; children: ReactNode }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "warning" ? "alert" : "status"} aria-live="polite">
      {tone === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
      <div>{children}</div>
    </div>
  );
}
