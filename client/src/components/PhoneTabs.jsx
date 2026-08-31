import { NavLink, useLocation } from 'react-router';
import { Landmark, LayoutGrid, Package, ScanLine } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { useLicence } from '../context/LicenceContext';
import { tap } from '../lib/native';
import { cx } from './ui';

/**
 * The five places a phone actually goes.
 *
 * A rail is a desktop object and a page of tiles is a good menu, but neither is
 * what a phone app is *shaped* like. On a handset the thing you reach for lives
 * at the bottom of the screen under your thumb, it is always there, and it does
 * not move — and that last part is why this is a fixed bar rather than one that
 * hides as you scroll. Somebody ringing up a customer should be able to land on
 * the register without looking, and a bar that slides away to give back
 * forty-nine pixels is a bar you have to go and find.
 *
 * Five, hard limit. Not because a sixth would not fit but because a thumb aims
 * badly: at six the targets are narrower than the pad of a finger and the shop
 * starts opening the wrong screen. Everything else is behind **More**, which is
 * the tile page that already existed.
 *
 * Built from the same permissions as every other menu, so a cashier does not
 * get a tab to a screen that will turn them away when they press it.
 */

/*
 * The four the shop asked for, in the order they asked for them.
 *
 * Not a guess at what a till wants: this is the set the owner named after
 * using it. Menu sits second rather than last because it is the way to
 * everything the other three are not, and a menu at the far end of a row is a
 * menu that stops being pressed.
 *
 * Each names a permission and the bar drops the ones this person does not
 * hold, so a cashier is never handed a tab to a screen that will turn them
 * away.
 */
const CANDIDATES = [
  { to: '/', label: 'Register', icon: ScanLine, end: true, permission: 'register' },
  { to: '/menu', label: 'Menu', icon: LayoutGrid },
  { to: '/admin/products', label: 'Products', icon: Package, permission: 'catalogue' },
  { to: '/admin/accounts', label: 'Accounts', icon: Landmark, permission: 'cashbox' },
];

function Tab({ to, label, icon: Icon, end }) {
  const t = useT();
  return (
    <NavLink
      to={to}
      end={end}
      /*
       * A tap that answers in the hand.
       *
       * On a counter the phone is often held low and half-watched, and the
       * click of a real till button is feedback this app otherwise has no way
       * of giving. It is also the cheapest way to tell somebody the press
       * landed on a screen that takes a moment to draw.
       */
      onClick={() => tap()}
      className={({ isActive }) =>
        cx(
          'relative flex flex-1 flex-col items-center justify-center gap-1 pt-2.5 pb-1',
          // 56px of height before the safe area, which is what a thumb needs.
          'min-h-[56px] transition-colors select-none',
          isActive ? 'text-brand-600' : 'text-slate-500 active:text-slate-800',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/*
           * The bar over the active tab, rather than colour alone. On a phone
           * held at an angle in a shop with fluorescent light, a hue shift is
           * not always legible; a shape is.
           */}
          <span
            aria-hidden="true"
            className={cx(
              'absolute top-0 h-[3px] w-8 rounded-b-full transition-opacity',
              isActive ? 'bg-brand-600 opacity-100' : 'opacity-0',
            )}
          />
          <Icon size={22} strokeWidth={isActive ? 2.4 : 2} aria-hidden="true" />
          <span className={cx('text-[11px] leading-none', isActive && 'font-semibold')}>
            {t(label)}
          </span>
        </>
      )}
    </NavLink>
  );
}

export default function PhoneTabs() {
  const { can } = useAuth();
  const { hasModule } = useLicence();
  const location = useLocation();

  /*
   * Everywhere but the sign-in screen.
   *
   * It used to hide on the menu page too, back when the last tab was "More"
   * and pointed there — a tab under the very list it had opened reads as a
   * button that does nothing. Menu is one of the four now, so hiding the bar
   * there would make the tab disappear the instant it was pressed, which is
   * worse: the way back to the register would go with it.
   */
  if (location.pathname === '/login') return null;

  const mine = CANDIDATES.filter(
    (item) =>
      (!item.permission || can(item.permission)) && (!item.module || hasModule(item.module)),
  ).slice(0, 5);

  return (
    <nav
      aria-label="Main"
      className={cx(
        'no-print fixed inset-x-0 bottom-0 z-40 flex desk:hidden',
        'border-t border-slate-200 bg-white/95 backdrop-blur',
        // The home indicator on an iPhone sits over the bottom of the screen,
        // so the row is lifted clear of it rather than drawn under it.
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      {mine.map((item) => (
        <Tab key={item.to} {...item} />
      ))}
    </nav>
  );
}
