import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, Loader2, X, XCircle } from 'lucide-react';

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
  secondary: 'bg-white text-slate-700 ring-1 ring-edge hover:bg-slate-50 active:bg-slate-100',
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
        'inline-flex shrink-0 select-none items-center justify-center rounded-lg font-medium whitespace-nowrap',
        'transition duration-150 ease-out',
        /*
         * A press that is felt.
         *
         * The counter machine is a touchscreen as often as not, where there is
         * no hover to tell you the finger landed on the button rather than a
         * millimetre beside it. The dip is tiny and it is undone the moment the
         * finger lifts, so a rung-up sale never waits on it.
         */
        'active:scale-[0.98] disabled:active:scale-100',
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
        /*
         * The field says it is wrong, and says what is wrong with it.
         *
         * A red ring is invisible to a screen reader and to anybody who cannot
         * separate red from grey — about one man in twelve. `aria-invalid`
         * carries the state, `aria-describedby` ties the message under the box
         * to the box, and `role="alert"` on the message means it is read out
         * when it appears rather than sitting there unnoticed.
         */
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${inputId}-note` : undefined}
        className={cx(
          'h-10 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 transition placeholder:text-slate-400',
          'focus:outline-none focus:ring-2',
          error ? 'ring-red-400 focus:ring-red-500' : 'ring-edge focus:ring-brand-600',
        )}
        {...props}
      />
      {error ? (
        <p id={`${inputId}-note`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${inputId}-note`} className="mt-1 text-xs text-slate-500">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * A password box you are allowed to look at.
 *
 * Every password field is a row of dots, which is right when somebody is
 * standing behind you and wrong every other minute. Two things it costs:
 *
 * A typo is invisible. Caps lock, a keyboard left in Arabic, a stray space
 * from a phone keyboard — all produce a field that looks exactly like a
 * correct one and a refusal that reads as the app being broken.
 *
 * And the browser's saved password is invisible too. `autocomplete` fills
 * these, and what it fills is whatever was saved the last time — which after a
 * password change is the old one. Somebody perfectly sure of their password
 * gets told it is wrong, because the box does not contain what they think it
 * contains and there is no way to find that out.
 *
 * The eye is off by default and never remembered. Showing it is a decision
 * made once, for one field, at a moment the person judged safe.
 */
export function PasswordInput({ label, hint, error, className, id, ...props }) {
  const [shown, setShown] = useState(false);
  const generated = useId();
  const inputId = id || props.name || generated;

  return (
    <div className={cx('w-full', className)}>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${inputId}-note` : undefined}
          className={cx(
            'h-10 w-full rounded-lg bg-white pr-10 pl-3 text-sm text-slate-900 ring-1 transition placeholder:text-slate-400',
            'focus:outline-none focus:ring-2',
            error ? 'ring-red-400 focus:ring-red-500' : 'ring-edge focus:ring-brand-600',
          )}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          // Not in the tab order: somebody tabbing from the password to the
          // submit button should not land here on the way.
          tabIndex={-1}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md p-2 text-slate-400 hover:text-slate-700"
          aria-label={shown ? 'Hide the password' : 'Show the password'}
          aria-pressed={shown}
        >
          {shown ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {error ? (
        <p id={`${inputId}-note`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${inputId}-note`} className="mt-1 text-xs text-slate-500">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function Select({ className, label, hint, error, children, id, ...props }) {
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
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${selectId}-note` : undefined}
        className={cx(
          'h-10 w-full rounded-lg bg-white px-3 text-sm text-slate-900 ring-1 transition',
          'focus:outline-none focus:ring-2',
          error ? 'ring-red-400 focus:ring-red-500' : 'ring-edge focus:ring-brand-600',
        )}
        {...props}
      >
        {children}
      </select>
      {error ? (
        <p id={`${selectId}-note`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${selectId}-note`} className="mt-1 text-xs text-slate-500">
            {hint}
          </p>
        )
      )}
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

/*
 * Each tone carries its own hairline in the same hue as its fill.
 *
 * A pale wash on a white card has no edge, so a row of badges reads as coloured
 * text rather than as a set of chips — and the paler tones (good, info) come
 * close to disappearing at a glance from a metre away, which is the distance a
 * shopkeeper actually reads a status from. The ring costs one pixel and gives
 * every badge the same weight, whatever its colour.
 */
const BADGE_TONES = {
  neutral: 'bg-slate-100 text-slate-700 ring-1 ring-slate-900/[0.06]',
  brand: 'bg-brand-50 text-brand-800 ring-1 ring-brand-600/15',
  good: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/15',
  warning: 'bg-amber-50 text-amber-800 ring-1 ring-amber-600/20',
  serious: 'bg-orange-50 text-orange-800 ring-1 ring-orange-600/20',
  critical: 'bg-red-50 text-red-700 ring-1 ring-red-600/20',
  info: 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/15',
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
      className="animate-backdrop-in fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
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

/**
 * A shape waiting for its content.
 *
 * A sweep rather than a pulse. Both say "loading", but a pulse fades the whole
 * block in and out — on a slow connection over a Beirut mobile signal that
 * reads as a screen flickering, while a sweep reads as work in progress and
 * moves in one direction. It falls back to a plain block under
 * prefers-reduced-motion, where it is still obviously a placeholder.
 */
export function Skeleton({ className }) {
  return <div className={cx('skeleton rounded-md bg-slate-200/70', className)} />;
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
          sat under the menu the moment it could be widened.

          On a phone there is no "down the right": the cart is underneath the
          shelf and the Charge button is at the bottom of it, which is exactly
          where these were landing — two toasts sitting on the one button the
          sale is waiting for. So on a narrow screen they come down from the
          top instead, where the only thing they cover is the search bar. */}
      <div
        className="pointer-events-none fixed top-14 left-2 z-[100] flex flex-col items-start gap-2 sm:top-auto sm:bottom-4 sm:left-[calc(var(--rail-width,68px)+1rem)]"
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

  /*
   * A picture that will not load falls back to the monogram.
   *
   * There was already a fallback for a product with no image at all, but a
   * product with a *broken* one went straight to the browser's torn-page icon —
   * and a shelf of those looks like the app is broken rather than like a few
   * links having gone stale. A link can rot for a dozen reasons the shop cannot
   * do anything about; the name is always there.
   *
   * Keyed on the URL so a corrected image is tried again rather than staying
   * blank because an earlier one failed.
   */
  const [broken, setBroken] = useState(null);

  if (product?.image_url && broken !== product.image_url) {
    return (
      <img
        src={product.image_url}
        alt=""
        onError={() => setBroken(product.image_url)}
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
