/**
 * Which screens the manual shows, and how to get to each one.
 *
 * A list rather than a script, so adding a chapter is adding a row. Each shot
 * names a route and, where the interesting thing is behind a button, the clicks
 * that open it — a manual that only shows pages at rest never shows the dialog
 * anybody actually needs help with.
 *
 * `needs` names the module a shot depends on, purely so this file can be read
 * against what a given client has bought.
 */
export const SHOTS = [
  /* ------------------------------------------------------------- the counter */
  {
    id: 'signin',
    route: '/login',
    anon: true,
    wait: 'text=Sign in',
    title: 'Signing in',
  },
  {
    id: 'register',
    route: '/',
    wait: '[data-testid="register"], main',
    title: 'The register',
  },
  {
    id: 'register-cart',
    route: '/',
    title: 'A sale in progress',
    // Three taps on the grid: a cart with something in it is the screen a
    // cashier actually looks at, and an empty one teaches nothing.
    steps: [
      { click: 'text=iPhone 15 128GB' },
      { click: 'text=Silicone Case iPhone 15' },
      { click: 'text=Tempered Glass Galaxy S24' },
    ],
  },
  {
    id: 'menu',
    route: '/menu',
    wait: 'main',
    title: 'The menu of big icons',
  },
  {
    id: 'my-sales',
    route: '/orders',
    wait: 'main',
    title: "This shift's sales",
  },

  /* -------------------------------------------------------------- back office */
  { id: 'dashboard', route: '/admin', wait: 'main', title: 'The dashboard' },
  { id: 'products', route: '/admin/products', wait: 'main', title: 'The catalogue' },
  { id: 'inventory', route: '/admin/inventory', wait: 'main', title: 'Stock on hand' },
  { id: 'orders', route: '/admin/orders', wait: 'main', title: 'Every sale' },
  { id: 'customers', route: '/admin/customers', wait: 'main', title: 'Customers and what they owe' },
  { id: 'suppliers', route: '/admin/suppliers', wait: 'main', title: 'Suppliers' },
  { id: 'cashbox', route: '/admin/cashbox', wait: 'main', title: 'The drawer' },
  { id: 'expenses', route: '/admin/expenses', wait: 'main', title: 'Expenses' },
  { id: 'profit', route: '/admin/profit', wait: 'main', title: 'Profit' },
  { id: 'accounts', route: '/admin/accounts', wait: 'main', title: 'Accounts' },
  { id: 'documents', route: '/admin/documents', wait: 'main', title: 'Quotations and invoices', needs: 'documents' },
  { id: 'repairs', route: '/admin/repairs', wait: 'main', title: 'Repairs', needs: 'repairs' },
  { id: 'trade-ins', route: '/admin/trade-ins', wait: 'main', title: 'Trade-ins', needs: 'repairs' },
  { id: 'installments', route: '/admin/installments', wait: 'main', title: 'Instalments', needs: 'installments' },
  { id: 'sims', route: '/admin/sims', wait: 'main', title: 'SIM cards', needs: 'sims' },
  { id: 'cards', route: '/admin/cards', wait: 'main', title: 'Recharge cards', needs: 'cards' },
  { id: 'labels', route: '/admin/labels', wait: 'main', title: 'Barcode labels', needs: 'labels' },
  { id: 'import', route: '/admin/import', wait: 'main', title: 'Importing a catalogue', needs: 'imports' },
  { id: 'branches', route: '/admin/branches', wait: 'main', title: 'Branches', needs: 'branches' },
  { id: 'stock-transfers', route: '/admin/stock-transfers', wait: 'main', title: 'Moving stock', needs: 'branches' },
  { id: 'staff', route: '/admin/users', wait: 'main', title: 'Staff and what they may do' },
  { id: 'settings', route: '/admin/settings', wait: 'main', title: 'Settings' },
];

/** Just the ones a given shop can actually see, for a per-client build. */
export const shotsFor = (modules) =>
  !modules ? SHOTS : SHOTS.filter((s) => !s.needs || modules.includes(s.needs));
