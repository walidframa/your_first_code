/**
 * The app in Arabic, and the right way round.
 *
 * Two decisions worth knowing about.
 *
 * **The English string is the key.** `t('Current sale')` rather than
 * `t('checkout.currentSale')`. Retrofitting an app that already has its words
 * written in it, invented keys mean touching every line twice and reading code
 * that no longer says what it shows — and anything not yet translated falls
 * back to perfectly good English instead of a dotted path nobody can read.
 *
 * **The direction is on the document, not in the components.** `dir="rtl"`
 * makes the browser lay text and every flex row out the other way by itself.
 * What it does not flip is the handful of physical classes — `ml-2`, `pl-9`,
 * `text-right` — and those are flipped in one block at the end of index.css
 * rather than by rewriting hundreds of class names into logical ones.
 */

export const LANGUAGES = [
  ['en', 'English', 'ltr'],
  ['ar', 'العربية', 'rtl'],
];

const KEY = 'pos_lang';

/*
 * The counter first.
 *
 * A shop that hires somebody who reads Arabic sits them at the register, so the
 * register, the payment sheet, the receipt and the menu are translated
 * thoroughly. The deeper back-office screens — the ones the owner uses, and the
 * ones full of accounting words that a wrong translation would make dangerous —
 * fall back to English until each is done properly, which is a better failure
 * than a half-Arabic screen nobody trusts.
 */
const AR = {
  // — signing in ————————————————————————————————————————————————
  'Sign in': 'تسجيل الدخول',
  'Signing in…': 'جارٍ الدخول…',
  Username: 'اسم المستخدم',
  Password: 'كلمة السر',
  'Front Desk': 'الواجهة',
  'Sign in to open the register': 'سجّل الدخول لفتح الصندوق',
  Language: 'اللغة',
  'Applies to this device and is remembered on it, so the counter and the back office can differ.':
    'يُطبَّق على هذا الجهاز ويُحفظ عليه، فيمكن أن تختلف لغة الصندوق عن لغة الإدارة.',
  'Login failed': 'تعذّر تسجيل الدخول',
  'Your session ended — sign in again to carry on. Nothing you saved is lost.':
    'انتهت الجلسة — سجّل الدخول من جديد للمتابعة. لم يضع شيء مما حفظته.',
  'Demo accounts': 'حسابات للتجربة',
  'Store owner': 'صاحب المحل',
  'Full back office': 'كل الإدارة',
  Cashier: 'الكاشير',
  'Register only': 'شاشة البيع فقط',

  // — the menu ——————————————————————————————————————————————————
  Register: 'البيع',
  Transfers: 'الحوالات',
  Vouchers: 'السندات',
  'My sales': 'مبيعاتي',
  Logins: 'الحسابات المحفوظة',
  Selling: 'البيع',
  Documents: 'الفواتير',
  Orders: 'المبيعات',
  Repairs: 'التصليحات',
  'Trade-ins': 'الشراء من الزبائن',
  Customers: 'الزبائن',
  Instalments: 'التقسيط',
  Suppliers: 'الموردون',
  Money: 'المال',
  Dashboard: 'لوحة المعلومات',
  Accounts: 'الحسابات',
  Cashbox: 'صندوق النقد',
  Expenses: 'المصاريف',
  Profit: 'الأرباح',
  Stock: 'المخزون',
  Products: 'المنتجات',
  Inventory: 'الجرد',
  'Move stock': 'نقل البضاعة',
  'SIM cards': 'الشرائح',
  Cards: 'البطاقات',
  Labels: 'الملصقات',
  Import: 'استيراد',
  Setup: 'الإعدادات',
  Shopify: 'شوبيفاي',
  Branches: 'الفروع',
  Staff: 'الموظفون',
  Settings: 'الإعدادات',
  Collapse: 'طيّ القائمة',
  'Collapse the menu': 'طيّ القائمة',
  'Expand the menu': 'توسيع القائمة',
  Menu: 'القائمة',
  'Hide the menu': 'إخفاء القائمة',
  'Show the menu': 'إظهار القائمة',
  Counter: 'الكاشير',
  Owner: 'صاحب المحل',
  Cashier: 'كاشير',

  // — when the people who sold you this app come in ——————————————
  '{name} from support is in your shop right now.': '{name} من الدعم داخل محلك الآن.',
  'You are in this shop as support. They can see you, and every change is logged.':
    'أنت داخل هذا المحل كدعم فني. هم يرونك، وكل تعديل يُسجَّل.',
  'Support visits': 'زيارات الدعم',
  'When the people who sold you this app came in, and what they changed':
    'متى دخل من باعك هذا البرنامج، وما الذي غيّره',
  '1 change': 'تعديل واحد',
  '{count} changes': '{count} تعديلات',
  'They looked, and changed nothing.': 'اطّلعوا فقط، ولم يغيّروا شيئاً.',
  'Cash payment': 'الدفع نقداً',
  'Card payment': 'الدفع بالبطاقة',
  'Log out': 'تسجيل الخروج',

  // — a phone in part-exchange ————————————————————————————————
  'Traded in': 'مقايضة',
  'Take it off': 'إلغاء المقايضة',
  'To pay': 'المطلوب',
  'You pay the customer': 'تدفع للزبون',
  'Pay the customer': 'ادفع للزبون',
  'Part-exchange': 'مقايضة',
  'Hand the customer': 'سلّم الزبون',
  'out of the drawer?': 'من الصندوق؟',

  // — the register ———————————————————————————————————————————————
  'Current sale': 'الفاتورة الحالية',
  'No items yet': 'لا يوجد أصناف بعد',
  'Scan a barcode or tap a product to start the sale.':
    'امسح الباركود أو اضغط على منتج لبدء الفاتورة.',
  'Scan barcode or search products…': 'امسح الباركود أو ابحث عن منتج…',
  'Scan barcode or search products': 'امسح الباركود أو ابحث عن منتج',
  'press / to focus': 'اضغط / للبحث',
  All: 'الكل',
  Hold: 'تعليق',
  Clear: 'إلغاء',
  Held: 'معلّقة',
  Discount: 'حسم',
  Subtotal: 'المجموع',
  Tax: 'الضريبة',
  Total: 'الإجمالي',
  'In LBP': 'بالليرة',
  Charge: 'تحصيل',
  'New sale': 'فاتورة جديدة',
  'Add customer': 'إضافة زبون',
  'Change customer': 'تغيير الزبون',
  'Choose a customer': 'اختر زبوناً',
  'Search by name or phone…': 'ابحث بالاسم أو الرقم…',
  owes: 'عليه',
  each: 'للواحدة',
  'Make it a gift': 'اجعلها هدية',
  '★ Gift — free': '★ هدية — مجاناً',
  Sold: 'مباعة',
  'Sold out': 'نفدت',
  left: 'متبقّي',
  'no credit': 'لا يوجد رصيد',
  card: 'بطاقة',
  Sales: 'المبيعات',
  'Buy in': 'شراء',
  Repair: 'تصليح',
  'Sell a SIM': 'بيع شريحة',
  'Send credit': 'تعبئة رصيد',
  'On account — pick a customer first': 'على الحساب — اختر زبوناً أولاً',
  "Put on {name}'s account": 'على حساب {name}',

  // — taking the money ————————————————————————————————————————————
  'Take payment': 'استلام الدفعة',
  Cash: 'نقداً',
  Card: 'بطاقة',
  Account: 'على الحساب',
  'Amount due': 'المطلوب',
  'Still due': 'الباقي',
  Change: 'الباقي للزبون',
  'Confirm': 'تأكيد',
  'Payment complete': 'تمت العملية',
  Receipt: 'الإيصال',
  Print: 'طباعة',
  'Send on WhatsApp': 'إرسال عبر واتساب',
  Dollars: 'دولار',
  'Lebanese pounds (LBP)': 'ليرة لبنانية',
  'All dollars': 'كل المبلغ دولار',
  'All pounds': 'كل المبلغ ليرة',
  exact: 'بالضبط',
  short: 'ناقص',
  over: 'زيادة',

  // — the drawer ————————————————————————————————————————————————
  'Cashbox closed': 'صندوق النقد مقفل',
  'Open the cashbox': 'فتح صندوق النقد',
  'Open cashbox': 'فتح الصندوق',
  'Cash sales are refused until it is open': 'لا يمكن البيع نقداً قبل فتحه',
  'Cash in': 'إدخال نقد',
  'Cash out': 'إخراج نقد',
  'Close the cashbox': 'إقفال صندوق النقد',
  'Cash on hand': 'النقد الموجود',
  'Counted at close': 'يُحسب عند الإقفال',
  profit: 'ربح',
  'Show the drawer detail': 'إظهار تفاصيل الصندوق',
  'Hide the drawer detail': 'إخفاء تفاصيل الصندوق',
  'Refresh cash on hand': 'تحديث النقد الموجود',

  // — when the server is away ——————————————————————————————————————
  'Selling on its own — the server is not answering.':
    'المحل يبيع لوحده — لا يوجد اتصال بالخادم.',
  'Send now': 'إرسال الآن',
  /*
   * Arabic counts nouns differently at one, two, and beyond, and getting it
   * wrong reads as badly as a mistranslation. Rather than build a plural engine
   * for three sentences, the one-sale line is written out in words and the
   * many-sale line puts the number after a plural noun, which stays grammatical
   * at any count.
   */
  'One sale waiting, and nothing is lost.': 'فاتورة واحدة بانتظار الإرسال، ولم يضع شيء.',
  '{count} sales waiting, and nothing is lost.':
    'فواتير بانتظار الإرسال: {count} — ولم يضع شيء.',
  'One sale waiting ({amount}), and nothing is lost.':
    'فاتورة واحدة بانتظار الإرسال ({amount})، ولم يضع شيء.',
  '{count} sales waiting ({amount}), and nothing is lost.':
    'فواتير بانتظار الإرسال: {count} ({amount}) — ولم يضع شيء.',
  'Catching up — one sale to send.': 'جارٍ اللحاق — فاتورة واحدة للإرسال.',
  'Catching up — {count} sales to send.': 'جارٍ اللحاق — فواتير للإرسال: {count}.',
  'One sale the server would not take': 'فاتورة واحدة رفضها الخادم',
  '{count} sales the server would not take': 'فواتير رفضها الخادم: {count}',
  ', among others': '، وغيرها',
  'The money was taken, so these need somebody to look at them.':
    'المبلغ قُبض، فهذه تحتاج من ينظر فيها.',

  // — words that turn up everywhere ————————————————————————————————
  Save: 'حفظ',
  'Save changes': 'حفظ التعديلات',
  Saved: 'تم الحفظ',
  Cancel: 'إلغاء',
  Close: 'إغلاق',
  Delete: 'حذف',
  Edit: 'تعديل',
  Add: 'إضافة',
  Search: 'بحث',
  Name: 'الاسم',
  Phone: 'رقم الهاتف',
  Price: 'السعر',
  Cost: 'الكلفة',
  Quantity: 'الكمية',
  Date: 'التاريخ',
  Status: 'الحالة',
  Customer: 'الزبون',
  Product: 'المنتج',
  Completed: 'مكتملة',
  Refunded: 'مرجعة',
  Loading: 'جارٍ التحميل',
  'Loading…': 'جارٍ التحميل…',
  Yes: 'نعم',
  No: 'لا',
};

const DICTS = { ar: AR };

export function getLanguage() {
  const stored = globalThis.localStorage?.getItem(KEY);
  return LANGUAGES.some(([id]) => id === stored) ? stored : 'en';
}

export function directionOf(language) {
  return LANGUAGES.find(([id]) => id === language)?.[2] || 'ltr';
}

/**
 * Put the whole document into a language, and remember it.
 *
 * Written onto the root element rather than through a stylesheet so it applies
 * before the first paint — and called once before React renders, so an Arabic
 * till never flashes an English page laid out backwards on the way in.
 */
export function applyLanguage(language = getLanguage()) {
  const chosen = LANGUAGES.some(([id]) => id === language) ? language : 'en';
  const root = globalThis.document?.documentElement;
  if (root) {
    root.lang = chosen;
    root.dir = directionOf(chosen);
  }
  globalThis.localStorage?.setItem(KEY, chosen);
  return chosen;
}

/**
 * A word, in the language in force.
 *
 * Missing translations return the English they were given, which is the whole
 * reason the English is the key: a screen nobody has got to yet reads as
 * English rather than as a broken key, and stays usable.
 */
export function translate(language, text, vars) {
  const dict = DICTS[language];
  let out = (dict && dict[text]) || text;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}
