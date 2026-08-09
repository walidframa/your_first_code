import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function money(n) {
  const value = Number(n) || 0;
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

/* ---------------------------------------------------------------- Button */

const BUTTON_VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 active:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100 active:bg-slate-200',
  danger: 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm',
  subtle: 'bg-slate-100 text-slate-700 hover:bg-slate-200 active:bg-slate-300',
};

const BUTTON_SIZES = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2',
  xl: 'h-14 px-6 text-lg gap-2.5',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  loading = false,
  disabled,
  children,
  ...props
}) {
  return (
    <button
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-lg font-medium whitespace-nowrap transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- Input */

export function Input({ className, label, hint, error, id, ...props }) {
  // Always produce an id so the label is associated with the field, even when
  // the caller passes neither id nor name.
  const generated = useId();
  const inputId = id || props.name || generated;
  return (
    <div className={cx('w-full', className)}>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cx(
          'h-10 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 transition placeholder:text-slate-400',
          'focus:outline-none focus:ring-2',
          error ? 'ring-red-400 focus:ring-red-500' : 'ring-slate-300 focus:ring-brand-600',
        )}
        {...props}
      />
      {error ? (
        <p className="mt-1 text-xs text-red-600">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>
      )}
    </div>
  );
}

export function Select({ className, label, children, id, ...props }) {
  const generated = useId();
  const selectId = id || props.name || generated;
  return (
    <div className={cx('w-full', className)}>
      {label && (
        <label htmlFor={selectId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className="h-10 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 ring-slate-300 transition focus:outline-none focus:ring-2 focus:ring-brand-600"
        {...props}
      >
        {children}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ Card */

export function Card({ className, children, ...props }) {
  return (
    <div
      className={cx('rounded-xl bg-white ring-1 ring-slate-900/[0.07] shadow-sm', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action, className }) {
  return (
    <div className={cx('flex items-start justify-between gap-4 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------------- Badge */

const BADGE_TONES = {
  neutral: 'bg-slate-100 text-slate-700',
  brand: 'bg-brand-50 text-brand-800',
  good: 'bg-emerald-50 text-emerald-800',
  warning: 'bg-amber-50 text-amber-800',
  serious: 'bg-orange-50 text-orange-800',
  critical: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
};

export function Badge({ tone = 'neutral', icon: Icon, children, className }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * Stock state as a badge. Status carries an icon and a word, never color alone.
 */
export function StockBadge({ stock, reorderPoint = 5 }) {
  if (stock <= 0) return <Badge tone="critical" icon={XCircle}>Out of stock</Badge>;
  if (stock <= reorderPoint) return <Badge tone="warning" icon={AlertTriangle}>Low · {stock}</Badge>;
  return <Badge tone="good" icon={CheckCircle2}>In stock · {stock}</Badge>;
}

/* ----------------------------------------------------------------- Modal */

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', className }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          'animate-sheet-in flex max-h-[90vh] w-full flex-col rounded-2xl bg-white shadow-2xl',
          sizes[size],
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {(title || onClose) && (
          <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
            </div>
            {onClose && (
              <button
                onClick={onClose}
                aria-label="Close"
                className="-m-1 rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A dialog's buttons, pinned to the bottom of it.
 *
 * A long form scrolls, and buttons that scroll with it end up half off the
 * bottom edge — which is exactly where somebody looks for "Save". Sticky rather
 * than in the modal's own footer slot, because it lives inside the scrolling
 * area and so needs no restructuring of the form above it: the fields keep
 * their order, and the buttons simply stop at the bottom of the frame.
 *
 * The negative margins pull it out to the dialog's full width so the content
 * scrolling underneath is covered rather than showing through at the edges.
 */
export function ModalActions({ children, className }) {
  return (
    <div
      className={cx(
        'sticky bottom-0 z-10 -mx-5 -mb-4 mt-5 flex items-center gap-2 border-t border-slate-100 bg-white px-5 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------ Empty state */

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cx('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
          <Icon size={20} />
        </div>
      )}
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }) {
  return <div className={cx('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

/* ---------------------------------------------------------------- Toasts */

const ToastContext = createContext(null);

const TOAST_ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TOAST_STYLES = {
  success: 'ring-emerald-200 text-emerald-700',
  error: 'ring-red-200 text-red-700',
  warning: 'ring-amber-200 text-amber-700',
  info: 'ring-slate-200 text-slate-600',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message, type = 'success', duration = 2600) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev, { id, message, type }].slice(-3));
      if (duration) setTimeout(() => dismiss(id), duration);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Bottom-left, clear of the nav rail: away from the scan bar at the top
          and from the cart totals and Charge button down the right. The offset
          follows the rail's own width, which the layout publishes — a fixed one
          sat under the menu the moment it could be widened. */}
      <div
        className="pointer-events-none fixed bottom-4 left-[calc(var(--rail-width,68px)+1rem)] z-[100] flex flex-col items-start gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => {
          const Icon = TOAST_ICONS[t.type] || Info;
          return (
            <div
              key={t.id}
              className={cx(
                'animate-toast-in pointer-events-auto flex items-center gap-2.5 rounded-xl bg-white px-4 py-2.5 text-sm font-medium shadow-lg ring-1',
                TOAST_STYLES[t.type],
              )}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="text-slate-800">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="-mr-1 rounded p-0.5 text-slate-400 transition hover:text-slate-700"
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx.toast;
}

/* ----------------------------------------------------- Product thumbnail */

const THUMB_TINTS = [
  'bg-rose-100 text-rose-700',
  'bg-amber-100 text-amber-700',
  'bg-emerald-100 text-emerald-700',
  'bg-sky-100 text-sky-700',
  'bg-violet-100 text-violet-700',
  'bg-teal-100 text-teal-700',
];

/**
 * Product image with a deterministic monogram fallback, so a catalog imported
 * without images still looks intentional rather than broken.
 */
export function ProductThumb({ product, size = 'md', className }) {
  const sizes = {
    sm: 'h-9 w-9 text-xs rounded-lg',
    md: 'h-12 w-12 text-sm rounded-xl',
    lg: 'h-16 w-16 text-lg rounded-xl',
  };

  const name = product?.name || '';
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  const hash = Array.from(name).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const tint = THUMB_TINTS[hash % THUMB_TINTS.length];

  if (product?.image_url) {
    return (
      <img
        src={product.image_url}
        alt=""
        className={cx('object-cover ring-1 ring-slate-900/5', sizes[size], className)}
      />
    );
  }

  if (product?.image_emoji) {
    return (
      <div className={cx('flex items-center justify-center bg-slate-100', sizes[size], className)}>
        <span className="text-xl leading-none">{product.image_emoji}</span>
      </div>
    );
  }

  return (
    <div
      className={cx('flex items-center justify-center font-semibold', tint, sizes[size], className)}
      aria-hidden="true"
    >
      {initials || '—'}
    </div>
  );
}
