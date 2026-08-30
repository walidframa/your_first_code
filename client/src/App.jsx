import { Navigate, Routes, Route } from 'react-router';
import Login from './pages/Login';
import SupportEntry from './pages/SupportEntry';
import MenuPage from './pages/Menu';
import Transfers from './pages/Transfers';
import Vouchers from './pages/Vouchers';
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
import AdminInstallments from './pages/admin/Installments';
import AdminEmployees from './pages/admin/Employees';
import AdminUsers from './pages/admin/Users';
import AdminBranches from './pages/admin/Branches';
import AdminStockTransfers from './pages/admin/StockTransfers';
import AdminSims from './pages/admin/Sims';
import AdminSettings from './pages/admin/Settings';
import AdminParties from './pages/admin/Parties';
import AdminDocuments from './pages/admin/Documents';
import { DocumentNew } from './pages/admin/Documents';
import AdminCapital from './pages/admin/Capital';
import AdminChartOfAccounts from './pages/admin/ChartOfAccounts';
import AdminJournal from './pages/admin/Journal';
import AdminTrialBalance from './pages/admin/TrialBalance';
import AdminVat from './pages/admin/Vat';
import AdminRevaluation from './pages/admin/Revaluation';
import AdminClosing from './pages/admin/Closing';
import { Areas as AdminAreas, CostCentres as AdminCostCentres } from './pages/admin/Dimensions';
import AdminLabels from './pages/admin/Labels';
import AdminShopify from './pages/admin/Shopify';
import AdminCashSessions from './pages/admin/CashSessions';
import AdminExpenses from './pages/admin/Expenses';
import AdminRepairs from './pages/admin/Repairs';
import AdminTradeIns from './pages/admin/TradeIns';
import HeldAccounts from './pages/admin/HeldAccounts';
import AdminProfit from './pages/admin/Profit';
import AdminCards from './pages/admin/Cards';
import AdminAccounts from './pages/admin/Accounts';

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
  ['vouchers', '/vouchers'],
  ['cashbox', '/admin/accounts'],
  ['repairs', '/admin/repairs'],
  ['reports', '/admin'],
  ['documents', '/admin/documents'],
  ['catalogue', '/admin/products'],
  ['inventory', '/admin/inventory'],
  ['transfer_stock', '/admin/stock-transfers'],
  ['branches', '/admin/branches'],
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
      {/* Outside the protected block on purpose: this is the route that *makes*
          somebody signed in, so requiring a session to reach it would be a door
          that can only be opened from inside. */}
      <Route path="/support" element={<SupportEntry />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Landing />} />
        {/* Reachable by everyone: it is the whole menu on a small screen, and
            it only ever shows the screens this person may open. */}
        <Route path="/menu" element={<MenuPage />} />
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
          path="/vouchers"
          element={
            <ProtectedRoute permission="vouchers">
              <Vouchers />
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
        {/*
          * Raising one is a screen, not a dialog. Static segments outrank the
          * `:kind` route below, so `/new` cannot be mistaken for a kind.
          */}
        <Route
          path="/admin/documents/new"
          element={
            <ProtectedRoute permission="documents">
              <DocumentNew />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/documents/new/:kind"
          element={
            <ProtectedRoute permission="documents">
              <DocumentNew />
            </ProtectedRoute>
          }
        />
        {/* One kind of paperwork at a time — the rail links straight to each,
            and the screen is the same one with its filter already set. */}
        <Route
          path="/admin/documents/:kind"
          element={
            <ProtectedRoute permission="documents">
              <AdminDocuments />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/capital"
          element={
            <ProtectedRoute permission="reports">
              <AdminCapital />
            </ProtectedRoute>
          }
        />
        {/* The books. Behind their own permission: a bookkeeper needs them and
            a cashier who can see the day's takings has no business in them. */}
        <Route
          path="/admin/chart-of-accounts"
          element={
            <ProtectedRoute permission="ledger">
              <AdminChartOfAccounts />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/journal"
          element={
            <ProtectedRoute permission="ledger">
              <AdminJournal />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/trial-balance"
          element={
            <ProtectedRoute permission="ledger">
              <AdminTrialBalance />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/vat"
          element={
            <ProtectedRoute permission="ledger">
              <AdminVat />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/revaluation"
          element={
            <ProtectedRoute permission="ledger">
              <AdminRevaluation />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/closing"
          element={
            <ProtectedRoute permission="ledger">
              <AdminClosing />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/cost-centres"
          element={
            <ProtectedRoute permission="ledger">
              <AdminCostCentres />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/areas"
          element={
            <ProtectedRoute permission="ledger">
              <AdminAreas />
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
        {/* SIMs sit with stock rather than with repairs: they are bought from a
            supplier, held, and sold like anything else on the shelf. */}
        <Route
          path="/admin/sims"
          element={
            <ProtectedRoute permission="inventory">
              <AdminSims />
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
          path="/admin/accounts"
          element={
            <ProtectedRoute permission="cashbox">
              <AdminAccounts />
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
          path="/admin/installments"
          element={
            <ProtectedRoute permission="parties">
              <AdminInstallments />
            </ProtectedRoute>
          }
        />
        {/*
          * Wages are the owner's, not a permission anybody can be given — see
          * lib/nav.js, which hides the door for the same reason.
          */}
        <Route
          path="/admin/employees"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminEmployees />
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
          path="/admin/stock-transfers"
          element={
            <ProtectedRoute permission="transfer_stock">
              <AdminStockTransfers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/branches"
          element={
            <ProtectedRoute permission="branches">
              <AdminBranches />
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
