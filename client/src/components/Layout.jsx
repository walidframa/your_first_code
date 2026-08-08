import { NavLink, Outlet } from 'react-router';
import {
  BarChart3,
  Banknote,
  Boxes,
  Building2,
  Contact,
  CreditCard,
  FileText,
  LogOut,
  Package,
  Receipt,
  ScanLine,
  ScrollText,
  ShoppingBag,
  Settings as SettingsIcon,
  Store,
  Tag,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  Wrench,
  HandCoins,
  KeyRound,
  ArrowLeftRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { cx } from './ui';

const REGISTER_NAV = [
  { to: '/', label: 'Register', icon: ScanLine, end: true, permission: 'register' },
  { to: '/orders', label: 'My sales', icon: Receipt },
  /*
   * Not an admin screen. Handing a customer back the iCloud the shop set up for
   * them is counter work, so whoever is at the counter can find it — the
   * password itself still takes the right permission.
   */
  { to: '/accounts', label: 'Accounts', icon: KeyRound },
  /*
   * The transfer desk sits with the register rather than in the back office:
   * it is counter work, often done by somebody who does nothing else.
   */
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, permission: 'transfers' },
];

/*
 * Grouped, because fifteen icons in a column is a list to be searched rather
 * than a menu to be read. The headings are what let someone look in the right
 * third of the rail instead of scanning all of it.
 */
const ADMIN_NAV = [
  {
    heading: 'Stock',
    items: [
      { to: '/admin/products', label: 'Products', icon: Package, permission: 'catalogue' },
      { to: '/admin/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory' },
      { to: '/admin/cards', label: 'Cards', icon: CreditCard, permission: 'cards' },
      { to: '/admin/labels', label: 'Labels', icon: Tag, permission: 'catalogue' },
      { to: '/admin/import', label: 'Import', icon: Upload, permission: 'imports' },
    ],
  },
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
      { to: '/admin/cashbox', label: 'Cashbox', icon: Banknote, permission: 'cashbox' },
      { to: '/admin/expenses', label: 'Expenses', icon: Wallet, permission: 'expenses' },
      { to: '/admin/profit', label: 'Profit', icon: TrendingUp, permission: 'reports' },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { to: '/admin/shopify', label: 'Shopify', icon: ShoppingBag, permission: 'imports' },
      { to: '/admin/users', label: 'Staff', icon: Users, permission: 'users' },
      { to: '/admin/settings', label: 'Settings', icon: SettingsIcon, permission: 'settings' },
    ],
  },
];

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cx(
          'group relative flex h-11 w-full flex-col items-center justify-center gap-0.5 rounded-lg transition',
          isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
        )
      }
    >
      <Icon size={18} aria-hidden="true" />
      <span className="text-[10px] leading-none font-medium">{label}</span>
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, can } = useAuth();

  /*
   * The rail shows what this person can actually reach. A menu full of doors
   * that bounce you back to the register is worse than a short menu — it reads
   * as the app being broken rather than as the job being narrower.
   */
  const allowed = (items) => items.filter((item) => !item.permission || can(item.permission));
  const groups = ADMIN_NAV.map((g) => ({ ...g, items: allowed(g.items) })).filter(
    (g) => g.items.length > 0,
  );

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-full bg-slate-100">
      <aside className="no-print flex w-[84px] shrink-0 flex-col items-center gap-1 bg-slate-900 px-2.5 py-3">
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
          <Store size={20} />
        </div>

        <nav className="flex w-full flex-col gap-1">
          {allowed(REGISTER_NAV).map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>

        {/* The rail scrolls rather than squashing: a shorter screen must not
            cut the last group off with no way to reach it. */}
        {groups.length > 0 && (
          <div className="relative min-h-0 w-full flex-1">
            <div className="h-full space-y-2 overflow-y-auto pt-2 pb-4">
              {groups.map((group) => (
                <nav key={group.heading} className="flex w-full flex-col gap-1">
                  <p className="px-1 pb-0.5 text-[9px] font-semibold tracking-wider text-slate-400 uppercase">
                    {group.heading}
                  </p>
                  {group.items.map((item) => (
                    <NavItem key={item.to} {...item} />
                  ))}
                </nav>
              ))}
            </div>
            {/* A hint that the list continues past the fold. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-slate-900 to-transparent" />
          </div>
        )}

        <div className="mt-auto flex w-full shrink-0 flex-col items-center gap-2 pt-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white"
            title={`${user.name} · ${user.role}`}
          >
            {initials}
          </div>
          <button
            onClick={logout}
            title="Log out"
            aria-label="Log out"
            className="flex h-9 w-full items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
