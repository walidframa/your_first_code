import { Navigate, Routes, Route } from 'react-router';
import Login from './pages/Login';
import Transfers from './pages/Transfers';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Checkout from './pages/Checkout';
import MyOrders from './pages/MyOrders';
import AdminDashboard from './pages/admin/Dashboard';
import AdminProducts from './pages/admin/Products';
import AdminInventory from './pages/admin/Inventory';
import AdminImport from './pages/admin/Import';
import AdminOrders from './pages/admin/Orders';
import AdminUsers from './pages/admin/Users';
import AdminSettings from './pages/admin/Settings';
import AdminParties from './pages/admin/Parties';
import AdminDocuments from './pages/admin/Documents';
import AdminLabels from './pages/admin/Labels';
import AdminShopify from './pages/admin/Shopify';
import AdminCashSessions from './pages/admin/CashSessions';
import AdminExpenses from './pages/admin/Expenses';
import AdminRepairs from './pages/admin/Repairs';
import AdminTradeIns from './pages/admin/TradeIns';
import HeldAccounts from './pages/admin/HeldAccounts';
import AdminProfit from './pages/admin/Profit';
import AdminCards from './pages/admin/Cards';

/*
 * Where signing in actually lands you.
 *
 * The register is the front door for almost everyone, but somebody hired to run
 * only the transfer desk would arrive at a till they are not allowed to use and
 * conclude the app was broken. So the first screen is the first one they can
 * work on.
 */
const HOME_ORDER = [
  ['register', '/'],
  ['transfers', '/transfers'],
  ['repairs', '/admin/repairs'],
  ['reports', '/admin'],
  ['documents', '/admin/documents'],
  ['catalogue', '/admin/products'],
  ['inventory', '/admin/inventory'],
  ['users', '/admin/users'],
];

function Landing() {
  const { can } = useAuth();
  if (can('register')) return <Checkout />;

  const target = HOME_ORDER.find(([permission]) => permission !== 'register' && can(permission));
  if (target) return <Navigate to={target[1]} replace />;

  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-slate-500">
      <p className="max-w-sm text-sm">
        Your account has no sections assigned yet. Ask whoever runs the shop to give you access.
      </p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Landing />} />
        <Route path="/orders" element={<MyOrders />} />
        <Route path="/accounts" element={<HeldAccounts />} />
        <Route
          path="/transfers"
          element={
            <ProtectedRoute permission="transfers">
              <Transfers />
            </ProtectedRoute>
          }
        />

        <Route
          path="/admin"
          element={
            <ProtectedRoute permission="reports">
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/products"
          element={
            <ProtectedRoute permission="catalogue">
              <AdminProducts />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/inventory"
          element={
            <ProtectedRoute permission="inventory">
              <AdminInventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/cards"
          element={
            <ProtectedRoute permission="cards">
              <AdminCards />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/import"
          element={
            <ProtectedRoute permission="imports">
              <AdminImport />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/documents"
          element={
            <ProtectedRoute permission="documents">
              <AdminDocuments />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/labels"
          element={
            <ProtectedRoute permission="catalogue">
              <AdminLabels />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/repairs"
          element={
            <ProtectedRoute permission="repairs">
              <AdminRepairs />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/trade-ins"
          element={
            <ProtectedRoute permission="repairs">
              <AdminTradeIns />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/expenses"
          element={
            <ProtectedRoute permission="expenses">
              <AdminExpenses />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/profit"
          element={
            <ProtectedRoute permission="reports">
              <AdminProfit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/cashbox"
          element={
            <ProtectedRoute permission="cashbox">
              <AdminCashSessions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/shopify"
          element={
            <ProtectedRoute permission="imports">
              <AdminShopify />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/customers"
          element={
            <ProtectedRoute permission="parties">
              <AdminParties type="customer" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/suppliers"
          element={
            <ProtectedRoute permission="parties">
              <AdminParties type="supplier" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/orders"
          element={
            <ProtectedRoute permission="reports">
              <AdminOrders />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <ProtectedRoute permission="settings">
              <AdminSettings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute permission="users">
              <AdminUsers />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
