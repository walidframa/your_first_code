import {
  ArrowLeftRight,
  BarChart3,
  Banknote,
  CalendarClock,
  Boxes,
  Building2,
  Contact,
  CreditCard,
  FileText,
  HandCoins,
  KeyRound,
  Landmark,
  Package,
  Receipt,
  ReceiptText,
  ScanLine,
  ScrollText,
  Settings as SettingsIcon,
  ShoppingBag,
  Smartphone,
  Store,
  Tag,
  Truck,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';

/*
 * Every screen in the app, once.
 *
 * Here rather than in the rail because there are now two ways to reach a
 * screen — the rail down the side, and the page of large tiles built for a
 * finger — and a second copy of this table is a screen that appears in one and
 * not the other, discovered by whoever cannot find it.
 *
 * The `label` is the English word and also the translation key, the same as
 * everywhere else in this app.
 */

/*
 * The counter. What somebody standing at the front of the shop does all day,
 * kept above the back office and never behind a heading — these are reached
 * dozens of times a shift, and a heading between them is a heading nobody reads
 * twice.
 */
export const COUNTER_NAV = [
  { to: '/', label: 'Register', icon: ScanLine, end: true, permission: 'register' },
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, permission: 'transfers' },
  { to: '/vouchers', label: 'Vouchers', icon: ReceiptText, permission: 'vouchers' },
  { to: '/orders', label: 'My sales', icon: Receipt },
  /*
   * Not a back-office screen. Handing a customer back the iCloud the shop set
   * up for them is counter work, so whoever is at the counter can find it — the
   * password itself still takes the right permission.
   *
   * "Logins", not "Accounts": the money accounts are a different thing with a
   * better claim on the word.
   */
  { to: '/accounts', label: 'Logins', icon: KeyRound },
];

/*
 * Grouped, because twenty icons in a column is a list to be searched rather
 * than a menu to be read. Selling first: it is what the shop does, and what
 * anyone opening the back office is most often here for.
 */
export const ADMIN_NAV = [
  {
    heading: 'Selling',
    items: [
      { to: '/admin/documents', label: 'Documents', icon: FileText, permission: 'documents' },
      { to: '/admin/orders', label: 'Orders', icon: ScrollText, permission: 'reports' },
      { to: '/admin/repairs', label: 'Repairs', icon: Wrench, permission: 'repairs' },
      { to: '/admin/trade-ins', label: 'Trade-ins', icon: HandCoins, permission: 'repairs' },
      { to: '/admin/customers', label: 'Customers', icon: Contact, permission: 'parties' },
      { to: '/admin/installments', label: 'Instalments', icon: CalendarClock, permission: 'parties' },
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
      { to: '/admin/sims', label: 'SIM cards', icon: Smartphone, permission: 'inventory' },
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
 * What this person can actually reach.
 *
 * A menu full of doors that bounce you back to the register is worse than a
 * short menu — it reads as the app being broken rather than as the job being
 * narrower.
 */
export const allowedItems = (items, can) =>
  items.filter((item) => !item.permission || can(item.permission));

export const allowedGroups = (can) =>
  ADMIN_NAV.map((group) => ({ ...group, items: allowedItems(group.items, can) })).filter(
    (group) => group.items.length > 0,
  );
