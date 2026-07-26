import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const linkClass = ({ isActive }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
    isActive ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-200'
  }`;

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">🛒</div>
          <span className="font-semibold text-slate-900">Front Desk POS</span>
        </div>

        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={linkClass}>
            Checkout
          </NavLink>
          <NavLink to="/orders" className={linkClass}>
            My Sales
          </NavLink>
          {user.role === 'admin' && (
            <>
              <NavLink to="/admin" end className={linkClass}>
                Dashboard
              </NavLink>
              <NavLink to="/admin/products" className={linkClass}>
                Products
              </NavLink>
              <NavLink to="/admin/orders" className={linkClass}>
                Orders
              </NavLink>
              <NavLink to="/admin/users" className={linkClass}>
                Staff
              </NavLink>
            </>
          )}
        </nav>

        <div className="flex items-center gap-3">
          <div className="text-right text-sm">
            <p className="font-medium text-slate-800">{user.name}</p>
            <p className="text-xs uppercase tracking-wide text-slate-400">{user.role}</p>
          </div>
          <button
            onClick={logout}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
