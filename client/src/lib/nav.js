import {
  ArrowLeftRight,
  BarChart3,
  Banknote,
  CircleDollarSign,
  CalendarClock,
  ClipboardList,
  Boxes,
  Building2,
  Contact,
  CreditCard,
  FileText,
  HandCoins,
  IdCard,
  KeyRound,
  Landmark,
  Package,
  PiggyBank,
  Receipt,
  ReceiptText,
  ScanLine,
  ScrollText,
  Settings as SettingsIcon,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Store,
  Tag,
  Truck,
  TrendingUp,
  Upload,
  Users,
  Wallet,
  Warehouse,
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
  { to: '/transfers', label: 'Transfers', icon: ArrowLeftRight, permission: 'transfers', module: 'transfers' },
  { to: '/vouchers', label: 'Vouchers', icon: ReceiptText, permission: 'vouchers', module: 'vouchers' },
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
 *
 * Each group carries an icon of its own, because in the rail a heading is a row
 * like any other — the same height, the same shape, with a chevron on the end
 * saying it opens. A four-letter caption in grey is not something anybody
 * presses; a row that looks like the rows above it is.
 */
export const ADMIN_NAV = [
  {
    heading: 'Selling',
    icon: ShoppingCart,
    items: [
      { to: '/admin/orders', label: 'Sales', icon: ScrollText, permission: 'reports' },
      { to: '/admin/repairs', label: 'Repairs', icon: Wrench, permission: 'repairs' , module: 'repairs' },
      { to: '/admin/trade-ins', label: 'Trade-ins', icon: HandCoins, permission: 'repairs' , module: 'repairs' },
      { to: '/admin/customers', label: 'Customers', icon: Contact, permission: 'parties' },
      /*
       * Under Selling rather than under Setup, because that is where the money
       * is: an employee's account is a customer account, and what they owe sits
       * beside what everybody else owes.
       */
      { to: '/admin/employees', label: 'Employees', icon: IdCard, adminOnly: true, module: 'employees' },
      { to: '/admin/installments', label: 'Instalments', icon: CalendarClock, permission: 'parties' , module: 'installments' },
      { to: '/admin/suppliers', label: 'Suppliers', icon: Building2, permission: 'parties' },
    ],
  },
  {
    /*
     * The paperwork, one kind at a time.
     *
     * It used to be a single "Documents" screen opening on four hundred rows of
     * four different things, with tiles across the top to narrow it down — so
     * writing a purchase invoice meant a screen, a tile and then a dialog with
     * a type to pick, three choices deep for a job the shop does every week.
     * Each kind is its own row now: the list arrives filtered and the New
     * button on it already knows what it is making.
     */
    heading: 'Documents',
    icon: FileText,
    items: [
      { to: '/admin/documents/purchase-invoices', label: 'Purchase invoices', icon: Truck, permission: 'documents', module: 'documents' },
      { to: '/admin/documents/sales-invoices', label: 'Sales invoices', icon: Receipt, permission: 'documents', module: 'documents' },
      { to: '/admin/documents/quotations', label: 'Quotations', icon: ClipboardList, permission: 'documents', module: 'documents' },
      /* Made by converting a quotation rather than from scratch, but they
         exist, and a kind with no way to reach it is a kind that is lost. */
      { to: '/admin/documents/sales-orders', label: 'Sales orders', icon: FileText, permission: 'documents', module: 'documents' },
    ],
  },
  {
    heading: 'Money',
    icon: CircleDollarSign,
    items: [
      { to: '/admin', label: 'Dashboard', icon: BarChart3, end: true, permission: 'reports' },
      { to: '/admin/accounts', label: 'Accounts', icon: Landmark, permission: 'cashbox' },
      { to: '/admin/cashbox', label: 'Cashbox', icon: Banknote, permission: 'cashbox' },
      { to: '/admin/expenses', label: 'Expenses', icon: Wallet, permission: 'expenses' },
      { to: '/admin/profit', label: 'Profit', icon: TrendingUp, permission: 'reports' },
      /* What the shop is worth, which is the same arithmetic seen from further
         back — every month's profit, added to what the owner started with. */
      { to: '/admin/capital', label: 'Capital', icon: PiggyBank, permission: 'reports' },
    ],
  },
  {
    heading: 'Stock',
    icon: Warehouse,
    items: [
      { to: '/admin/products', label: 'Products', icon: Package, permission: 'catalogue' },
      { to: '/admin/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory' },
      { to: '/admin/stock-transfers', label: 'Move stock', icon: Truck, permission: 'transfer_stock' , module: 'branches' },
      { to: '/admin/sims', label: 'SIM cards', icon: Smartphone, permission: 'inventory' , module: 'sims' },
      { to: '/admin/cards', label: 'Cards', icon: CreditCard, permission: 'cards' , module: 'cards' },
      { to: '/admin/labels', label: 'Labels', icon: Tag, permission: 'catalogue' , module: 'labels' },
      { to: '/admin/import', label: 'Import', icon: Upload, permission: 'imports' , module: 'imports' },
    ],
  },
  {
    heading: 'Setup',
    icon: SlidersHorizontal,
    items: [
      { to: '/admin/shopify', label: 'Shopify', icon: ShoppingBag, permission: 'imports' , module: 'shopify' },
      { to: '/admin/branches', label: 'Branches', icon: Store, permission: 'branches' , module: 'branches' },
      { to: '/admin/users', label: 'Staff', icon: Users, permission: 'users' },
      { to: '/admin/settings', label: 'Settings', icon: SettingsIcon, permission: 'settings' },
    ],
  },
];

/**
 * What this person can actually reach.
 *
 * Two different questions, and both have to say yes. `can` is what this person
 * is allowed to do inside their shop; `hasModule` is what the shop bought at
 * all — the owner passes every permission there is and still must not see a
 * Repairs screen the shop never paid for.
 *
 * A menu full of doors that bounce you back to the register is worse than a
 * short menu: it reads as the app being broken rather than as the job being
 * narrower, or the plan being smaller.
 */
export const allowedItems = (items, can, hasModule = () => true, isAdmin = false) =>
  items.filter(
    (item) =>
      (!item.permission || can(item.permission)) &&
      (!item.module || hasModule(item.module)) &&
      /*
       * A third question, for the handful of screens that are the owner's
       * rather than a job's. Wages are the clearest case: a "payroll" checkbox
       * handed out by mistake is every salary in the building, so there is no
       * checkbox to hand out — an admin is the owner, and nobody else sees it.
       */
      (!item.adminOnly || isAdmin),
  );

export const allowedGroups = (can, hasModule = () => true, isAdmin = false) =>
  ADMIN_NAV.map((group) => ({
    ...group,
    items: allowedItems(group.items, can, hasModule, isAdmin),
  })).filter((group) => group.items.length > 0);
