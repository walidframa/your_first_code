import { Routes, Route } from 'react-router';
import Login from './pages/Login';
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
import AdminProfit from './pages/admin/Profit';

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
        <Route path="/" element={<Checkout />} />
        <Route path="/orders" element={<MyOrders />} />

        <Route
          path="/admin"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/products"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminProducts />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/inventory"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminInventory />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/import"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminImport />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/documents"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminDocuments />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/labels"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminLabels />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/repairs"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminRepairs />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/expenses"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminExpenses />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/profit"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminProfit />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/cashbox"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminCashSessions />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/shopify"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminShopify />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/customers"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminParties type="customer" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/suppliers"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminParties type="supplier" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/orders"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminOrders />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/settings"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminSettings />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/users"
          element={
            <ProtectedRoute roles={['admin']}>
              <AdminUsers />
            </ProtectedRoute>
          }
        />
      </Route>
    </Routes>
  );
}
