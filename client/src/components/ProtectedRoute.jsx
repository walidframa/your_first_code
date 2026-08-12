import { Navigate } from 'react-router';
import { useAuth } from '../context/AuthContext';
import ChangePassword from '../pages/ChangePassword';

/**
 * Guard a route by permission rather than by role.
 *
 * `roles` is still honoured for the few places where the distinction really is
 * owner-or-not. Everything else names the permission it needs, so granting it
 * to a cashier is all it takes to let them in.
 */
export default function ProtectedRoute({ roles, permission, children }) {
  const { user, loading, can } = useAuth();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  /*
   * Still on the password the app ships with, so nothing else happens yet.
   *
   * Here rather than as a banner somebody can ignore: `admin/admin123` is in
   * the README and on the sign-in screen of every copy of this, and a shop
   * reachable from the internet with it is open rather than protected. Placed
   * at the gate, so it is the first thing after signing in and never lands in
   * the middle of somebody's sale.
   */
  if (user.mustChangePassword) {
    return <ChangePassword forced />;
  }
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  if (permission && !can(permission)) {
    return <Navigate to="/" replace />;
  }
  return children;
}
