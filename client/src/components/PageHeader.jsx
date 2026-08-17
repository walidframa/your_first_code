/**
 * The title of a screen, and the buttons that act on the whole of it.
 *
 * The actions wrap onto their own line rather than being squeezed beside the
 * title: on a phone the title and two buttons do not fit across, and the way
 * that failed was the last button hanging off the right edge — a "New product"
 * reading "New produ" with no way to reach the rest of it.
 *
 * Narrower padding on a phone, too. Twenty-four pixels each side is a fine
 * margin on a monitor and an eighth of the screen on a handset.
 */
export default function PageHeader({ title, subtitle, actions, children }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {children}
    </header>
  );
}
