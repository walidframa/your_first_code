import { NavLink, Outlet } from 'react-router';
import {
  BarChart3,
  Boxes,
  LogOut,
  Package,
  Receipt,
  ScanLine,
  Settings as SettingsIcon,
  Store,
  Upload,
  Users,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { cx } from './ui';

const REGISTER_NAV = [
  { to: '/', label: 'Register', icon: ScanLine, end: true },
  { to: '/orders', label: 'My sales', icon: Receipt },
];

const ADMIN_NAV = [
  { to: '/admin', label: 'Dashboard', icon: BarChart3, end: true },
  { to: '/admin/products', label: 'Products', icon: Package },
  { to: '/admin/inventory', label: 'Inventory', icon: Boxes },
  { to: '/admin/import', label: 'Import', icon: Upload },
  { to: '/admin/orders', label: 'Orders', icon: Receipt },
  { to: '/admin/users', label: 'Staff', icon: Users },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      className={({ isActive }) =>
        cx(
          'group relative flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-xl transition',
          isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-400 hover:bg-slate-800 hover:text-white',
        )
      }
    >
      <Icon size={19} aria-hidden="true" />
      <span className="text-[10px] leading-none font-medium">{label}</span>
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();

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
          {REGISTER_NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>

        {user.role === 'admin' && (
          <>
            <div className="my-2 h-px w-8 bg-slate-700" role="separator" />
            <nav className="flex w-full flex-col gap-1">
              {ADMIN_NAV.map((item) => (
                <NavItem key={item.to} {...item} />
              ))}
            </nav>
          </>
        )}

        <div className="mt-auto flex w-full flex-col items-center gap-2 pt-3">
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
