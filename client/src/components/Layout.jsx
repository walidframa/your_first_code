import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  ArrowLeftRight,
  BarChart3,
  Banknote,
  Boxes,
  Building2,
  ChevronRight,
  Contact,
  CreditCard,
  FileText,
  LogOut,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ReceiptText,
  ScanLine,
  ScrollText,
  ShoppingBag,
  Settings as SettingsIcon,
  Store,
  Truck,
  Tag,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  Wrench,
  HandCoins,
  KeyRound,
  Landmark,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BranchSwitcher from './BranchSwitcher';
import { cx } from './ui';

/*
 * The counter. What somebody standing at the front of the shop does all day,
 * kept above the back office and never behind a heading — these are reached
 * dozens of times a shift, and a heading between them is a heading nobody reads
 * twice.
 */
const COUNTER_NAV = [
  { to: '/', label: 'Register', icon: ScanLine, end: true, permission: 'register' },
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, permission: 'transfers' },
  { to: '/vouchers', label: 'Vouchers', icon: ReceiptText, permission: 'vouchers' },
  { to: '/orders', label: 'My sales', icon: Receipt },
  /*
   * Not a back-office screen. Handing a customer back the iCloud the shop set
   * up for them is counter work, so whoever is at the counter can find it — the
   * password itself still takes the right permission.
   */
  /* "Logins", not "Accounts": the money accounts are a different thing with a
     better claim on the word. */
  { to: '/accounts', label: 'Logins', icon: KeyRound },
];

/*
 * Grouped, because twenty icons in a column is a list to be searched rather
 * than a menu to be read. Selling first: it is what the shop does, and what
 * anyone opening the back office is most often here for.
 */
const ADMIN_NAV = [
  {
    heading: 'Selling',
    items: [
      { to: '/admin/documents', label: 'Documents', icon: FileText, permission: 'documents' },
      { to: '/admin/orders', label: 'Orders', icon: ScrollText, permission: 'reports' },
      { to: '/admin/repairs', label: 'Repairs', icon: Wrench, permission: 'repairs' },
      { to: '/admin/trade-ins', label: 'Trade-ins', icon: HandCoins, permission: 'repairs' },
      { to: '/admin/customers', label: 'Customers', icon: Contact, permission: 'parties' },
      { to: '/admin/suppliers', label: 'Suppliers', icon: Building2, permission: 'parties' },
    ],
  },
  {
    heading: 'Money',
    items: [
      { to: '/admin', label: 'Dashboard', icon: BarChart3, end: true, permission: 'reports' },
      { to: '/admin/accounts', label: 'Accounts', icon: Landmark, permission: 'cashbox' },
      { to: '/admin/cashbox', label: 'Cashbox', icon: Banknote, permission: 'cashbox' },
      { to: '/admin/expenses', label: 'Expenses', icon: Wallet, permission: 'expenses' },
      { to: '/admin/profit', label: 'Profit', icon: TrendingUp, permission: 'reports' },
    ],
  },
  {
    heading: 'Stock',
    items: [
      { to: '/admin/products', label: 'Products', icon: Package, permission: 'catalogue' },
      { to: '/admin/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory' },
      { to: '/admin/stock-transfers', label: 'Move stock', icon: Truck, permission: 'transfer_stock' },
      { to: '/admin/cards', label: 'Cards', icon: CreditCard, permission: 'cards' },
      { to: '/admin/labels', label: 'Labels', icon: Tag, permission: 'catalogue' },
      { to: '/admin/import', label: 'Import', icon: Upload, permission: 'imports' },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { to: '/admin/shopify', label: 'Shopify', icon: ShoppingBag, permission: 'imports' },
      { to: '/admin/branches', label: 'Branches', icon: Store, permission: 'branches' },
      { to: '/admin/users', label: 'Staff', icon: Users, permission: 'users' },
      { to: '/admin/settings', label: 'Settings', icon: SettingsIcon, permission: 'settings' },
    ],
  },
];

/**
 * One row of the rail.
 *
 * Wide, the label is beside the icon and reads as a word. Narrow, the icon is
 * alone and the label becomes the tooltip — a nine-pixel caption under an icon
 * is not a label, it is a smudge, and it was costing the rail a third of its
 * height to say nothing.
 */
function NavItem({ to, label, icon: Icon, end, expanded }) {
  return (
    <NavLink
      to={to}
      end={end}
      /* Kept in both states: collapsed it is the only name the icon has, and
         expanded it still answers a truncated label. */
      title={label}
      className={({ isActive }) =>
        cx(
          'group relative flex items-center rounded-lg transition',
          expanded ? 'h-10 gap-3 px-3' : 'h-11 justify-center px-0',
          isActive
            ? 'bg-brand-600 text-white shadow-sm'
            : 'text-slate-400 hover:bg-slate-800 hover:text-white',
        )
      }
    >
      <Icon size={18} className="shrink-0" aria-hidden="true" />
      {expanded ? (
        <span className="truncate text-sm font-medium">{label}</span>
      ) : (
        // Named for a screen reader even when the icon stands alone.
        <span className="sr-only">{label}</span>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const { pathname } = useLocation();

  /*
   * Wide by default, and a preference rather than a state: an icon nobody has
   * learned yet is a guess, and twenty of them is a menu to be explored rather
   * than read. Whoever wants the space back can take it, once.
   */
  const [expanded, setExpanded] = useState(
    () => (localStorage.getItem('pos_nav_expanded') ?? 'true') === 'true',
  );

  useEffect(() => {
    localStorage.setItem('pos_nav_expanded', String(expanded));
    /*
     * Published for anything that has to sit clear of the rail but renders
     * outside it — the toasts, which otherwise appear underneath the menu the
     * moment it is widened.
     */
    document.documentElement.style.setProperty('--rail-width', expanded ? '212px' : '68px');
  }, [expanded]);

  /*
   * The rail shows what this person can actually reach. A menu full of doors
   * that bounce you back to the register is worse than a short menu — it reads
   * as the app being broken rather than as the job being narrower.
   */
  const allowed = (items) => items.filter((item) => !item.permission || can(item.permission));
  const counter = allowed(COUNTER_NAV);
  const groups = ADMIN_NAV.map((g) => ({ ...g, items: allowed(g.items) })).filter(
    (g) => g.items.length > 0,
  );

  /*
   * Which back-office groups are folded away.
   *
   * A shop lives on three or four screens and reaches the rest once a month, so
   * the rail is mostly a wall of things nobody is looking for. Folded by
   * heading rather than by item, remembered per person, and stored as a list of
   * what is *closed* so a group added later arrives open.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('pos_nav_collapsed') || '[]'));
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem('pos_nav_collapsed', JSON.stringify([...collapsed]));
  }, [collapsed]);

  const toggleGroup = (heading) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(heading)) next.delete(heading);
      else next.add(heading);
      return next;
    });

  /*
   * The group holding the screen you are on is never folded, whatever the
   * preference says. Otherwise arriving somewhere hides the page you are
   * looking at from the menu, and the way back is a guess.
   */
  const holdsCurrentPage = (group) =>
    group.items.some((item) =>
      item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full bg-slate-100">
      <aside
        className={cx(
          'no-print flex shrink-0 flex-col bg-slate-900 py-3 transition-[width] duration-150',
          expanded ? 'w-[212px] px-3' : 'w-[68px] px-2.5',
        )}
      >
        <div className={cx('mb-3 flex items-center', expanded ? 'gap-2.5 px-1' : 'justify-center')}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Store size={19} />
          </div>
          {expanded && (
            <span className="truncate text-sm font-semibold text-white">Front Desk</span>
          )}
        </div>

        <BranchSwitcher expanded={expanded} />

        <nav className="flex w-full flex-col gap-1">
          {counter.map((item) => (
            <NavItem key={item.to} {...item} expanded={expanded} />
          ))}
        </nav>

        {/* The rail scrolls rather than squashing: a shorter screen must not
            cut the last group off with no way to reach it. */}
        {groups.length > 0 && (
          <div className="relative mt-2 min-h-0 w-full flex-1">
            <div className="h-full space-y-3 overflow-y-auto pt-2 pb-5">
              {groups.map((group) => {
                /*
                 * Only foldable in the wide rail. Narrow, the heading is
                 * already a rule rather than a word, and a toggle with no name
                 * on it is a button nobody presses twice.
                 */
                const foldable = expanded;
                const open = !foldable || !collapsed.has(group.heading) || holdsCurrentPage(group);

                return (
                  <nav key={group.heading} className="flex w-full flex-col gap-1">
                    {foldable ? (
                      <button
                        onClick={() => toggleGroup(group.heading)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-1 rounded px-3 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase transition hover:text-slate-300"
                      >
                        <ChevronRight
                          size={11}
                          className={cx('shrink-0 transition-transform', open && 'rotate-90')}
                          aria-hidden="true"
                        />
                        {group.heading}
                      </button>
                    ) : (
                      /* Narrow, a heading would be four unreadable letters, so the
                         grouping is carried by a rule instead. */
                      <div className="mx-3 mb-1 border-t border-slate-700/70" aria-hidden="true" />
                    )}
                    {open &&
                      group.items.map((item) => (
                        <NavItem key={item.to} {...item} expanded={expanded} />
                      ))}
                  </nav>
                );
              })}
            </div>
            {/* A hint that the list continues past the fold. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-slate-900 to-transparent" />
          </div>
        )}

        <div className="mt-auto w-full shrink-0 space-y-1 pt-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse the menu' : 'Expand the menu'}
            title={expanded ? 'Collapse the menu' : 'Expand the menu'}
            className={cx(
              'flex h-9 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white',
              expanded ? 'gap-3 px-3' : 'justify-center',
            )}
          >
            {expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            {expanded && <span className="text-sm font-medium">Collapse</span>}
          </button>

          <div className="border-t border-slate-800 pt-2">
            <div
              className={cx('flex items-center', expanded ? 'gap-2.5 px-2 py-1' : 'justify-center')}
              title={expanded ? undefined : `${user.name} · ${user.role}`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[11px] font-semibold text-white">
                {initials}
              </div>
              {expanded && (
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{user.name}</p>
                  <p className="truncate text-[11px] text-slate-400 capitalize">{user.role}</p>
                </div>
              )}
            </div>

            <button
              onClick={logout}
              title="Log out"
              aria-label="Log out"
              className={cx(
                'mt-1 flex h-9 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white',
                expanded ? 'gap-3 px-3' : 'justify-center',
              )}
            >
              <LogOut size={17} />
              {expanded && <span className="text-sm font-medium">Log out</span>}
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
