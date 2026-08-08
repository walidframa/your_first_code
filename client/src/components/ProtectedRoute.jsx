import { Navigate } from 'react-router';
import { useAuth } from '../context/AuthContext';

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
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }
  if (permission && !can(permission)) {
    return <Navigate to="/" replace />;
  }
  return children;
}
