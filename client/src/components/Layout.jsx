import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import TabBar from './TabBar';
import { TabsProvider } from '../context/TabsContext';
import OfflineBar from './OfflineBar';
import { useT } from '../context/LanguageContext';
import {
  ChevronRight,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Store,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import BranchSwitcher from './BranchSwitcher';
import { cx } from './ui';
import { COUNTER_NAV, allowedGroups, allowedItems } from '../lib/nav';
import { useLicence } from '../context/LicenceContext';

/**
 * One row of the rail.
 *
 * Wide, the label is beside the icon and reads as a word. Narrow, the icon is
 * alone and the label becomes the tooltip — a nine-pixel caption under an icon
 * is not a label, it is a smudge, and it was costing the rail a third of its
 * height to say nothing.
 */
function NavItem({ to, label, icon: Icon, end, expanded }) {
  /*
   * Translated here rather than at each of the thirty call sites: the label is
   * the English word in the nav table above, which is also the key.
   */
  const t = useT();
  const name = t(label);

  return (
    <NavLink
      to={to}
      end={end}
      /* Kept in both states: collapsed it is the only name the icon has, and
         expanded it still answers a truncated label. */
      title={name}
      className={({ isActive }) =>
        cx(
          'group relative flex items-center rounded-lg transition',
          expanded ? 'h-10 gap-3 px-3' : 'h-11 justify-center px-0',
          isActive
            ? 'bg-brand-600 text-white shadow-sm'
            : 'text-slate-400 hover:bg-slate-800 hover:text-white',
        )
      }
    >
      <Icon size={18} className="shrink-0" aria-hidden="true" />
      {expanded ? (
        <span className="truncate text-sm font-medium">{name}</span>
      ) : (
        // Named for a screen reader even when the icon stands alone.
        <span className="sr-only">{name}</span>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const { pathname } = useLocation();
  const t = useT();

  /*
   * Wide by default, and a preference rather than a state: an icon nobody has
   * learned yet is a guess, and twenty of them is a menu to be explored rather
   * than read. Whoever wants the space back can take it, once.
   */
  const [expanded, setExpanded] = useState(
    () => (localStorage.getItem('pos_nav_expanded') ?? 'true') === 'true',
  );

  /*
   * The register gets the whole window.
   *
   * A counter monitor is usually square and small, and on one of those the rail
   * costs a column of products — the thing the screen is actually for. So on the
   * register the rail starts away, and comes back for whoever wants it; the
   * choice is remembered separately from the one above, because "I want the menu
   * while I do the books" and "I want it while I am serving" are different
   * answers from the same person.
   */
  const onRegister = pathname === '/';
  const [railOnRegister, setRailOnRegister] = useState(
    () => localStorage.getItem('pos_nav_on_register') === 'true',
  );
  const showRail = onRegister ? railOnRegister : true;

  useEffect(() => {
    localStorage.setItem('pos_nav_expanded', String(expanded));
  }, [expanded]);

  useEffect(() => {
    localStorage.setItem('pos_nav_on_register', String(railOnRegister));
  }, [railOnRegister]);

  useEffect(() => {
    /*
     * Published for anything that has to sit clear of the rail but renders
     * outside it — the toasts, which otherwise appear underneath the menu the
     * moment it is widened.
     */
    document.documentElement.style.setProperty(
      '--rail-width',
      showRail ? (expanded ? '212px' : '68px') : '0px',
    );
  }, [expanded, showRail]);

  /*
   * What this person may do, and what the shop actually bought. Both have to
   * say yes — the owner passes every permission and still cannot be shown a
   * screen the shop is not paying for.
   */
  const { hasModule } = useLicence();
  const counter = allowedItems(COUNTER_NAV, can, hasModule);
  const groups = allowedGroups(can, hasModule);

  /*
   * Which back-office groups are folded away.
   *
   * A shop lives on three or four screens and reaches the rest once a month, so
   * the rail is mostly a wall of things nobody is looking for. Folded by
   * heading rather than by item, remembered per person, and stored as a list of
   * what is *closed* so a group added later arrives open.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('pos_nav_collapsed') || '[]'));
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    localStorage.setItem('pos_nav_collapsed', JSON.stringify([...collapsed]));
  }, [collapsed]);

  const toggleGroup = (heading) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(heading)) next.delete(heading);
      else next.add(heading);
      return next;
    });

  /*
   * The group holding the screen you are on is never folded, whatever the
   * preference says. Otherwise arriving somewhere hides the page you are
   * looking at from the menu, and the way back is a guess.
   */
  const holdsCurrentPage = (group) =>
    group.items.some((item) =>
      item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );

  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <TabsProvider>
    <div className="flex h-full bg-slate-100">
      {/*
       * The rail is a desktop thing.
       *
       * Below `lg` it is not narrowed, it is gone: two hundred pixels of menu on
       * a phone is most of the screen, and a menu that slides over the page is a
       * second thing to learn and a second thing to get stuck open. The page of
       * tiles is the menu on a small screen, and Back is how you leave it.
       */}
      {showRail && (
      <aside
        className={cx(
          'no-print hidden shrink-0 flex-col bg-slate-900 py-3 transition-[width] duration-150 lg:flex',
          expanded ? 'w-[212px] px-3' : 'w-[68px] px-2.5',
        )}
      >
        <div className={cx('mb-3 flex items-center', expanded ? 'gap-2.5 px-1' : 'justify-center')}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
            <Store size={19} />
          </div>
          {expanded && (
            <span className="truncate text-sm font-semibold text-white">Front Desk</span>
          )}
        </div>

        <BranchSwitcher expanded={expanded} />

        <nav className="flex w-full flex-col gap-1">
          {/* The same list at a size a finger can land on. Kept at the top of
              the rail rather than buried in the back office, because on a touch
              screen it is the menu somebody actually uses. */}
          <NavItem to="/menu" label="Menu" icon={LayoutGrid} expanded={expanded} />
          {counter.map((item) => (
            <NavItem key={item.to} {...item} expanded={expanded} />
          ))}
        </nav>

        {/* The rail scrolls rather than squashing: a shorter screen must not
            cut the last group off with no way to reach it. */}
        {groups.length > 0 && (
          <div className="relative mt-2 min-h-0 w-full flex-1">
            <div className="h-full space-y-3 overflow-y-auto pt-2 pb-5">
              {groups.map((group) => {
                /*
                 * Only foldable in the wide rail. Narrow, the heading is
                 * already a rule rather than a word, and a toggle with no name
                 * on it is a button nobody presses twice.
                 */
                const foldable = expanded;
                const open = !foldable || !collapsed.has(group.heading) || holdsCurrentPage(group);

                return (
                  <nav key={group.heading} className="flex w-full flex-col gap-1">
                    {foldable ? (
                      <button
                        onClick={() => toggleGroup(group.heading)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-1 rounded px-3 pb-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase transition hover:text-slate-300"
                      >
                        <ChevronRight
                          size={11}
                          className={cx('shrink-0 transition-transform', open && 'rotate-90')}
                          aria-hidden="true"
                        />
                        {t(group.heading)}
                      </button>
                    ) : (
                      /* Narrow, a heading would be four unreadable letters, so the
                         grouping is carried by a rule instead. */
                      <div className="mx-3 mb-1 border-t border-slate-700/70" aria-hidden="true" />
                    )}
                    {open &&
                      group.items.map((item) => (
                        <NavItem key={item.to} {...item} expanded={expanded} />
                      ))}
                  </nav>
                );
              })}
            </div>
            {/* A hint that the list continues past the fold. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-slate-900 to-transparent" />
          </div>
        )}

        <div className="mt-auto w-full shrink-0 space-y-1 pt-3">
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t('Collapse the menu') : t('Expand the menu')}
            title={expanded ? t('Collapse the menu') : t('Expand the menu')}
            className={cx(
              'flex h-9 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white',
              expanded ? 'gap-3 px-3' : 'justify-center',
            )}
          >
            {expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            {expanded && <span className="text-sm font-medium">{t('Collapse')}</span>}
          </button>

          {/* Only here, because this is the only screen the rail gets out of the
              way of — and the only place it needs a handle to do it from. */}
          {onRegister && (
            <button
              onClick={() => setRailOnRegister(false)}
              aria-label={t('Hide the menu')}
              title={t('Hide the menu')}
              className={cx(
                'flex h-9 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white',
                expanded ? 'gap-3 px-3' : 'justify-center',
              )}
            >
              <MenuIcon size={17} />
              {expanded && <span className="text-sm font-medium">{t('Hide the menu')}</span>}
            </button>
          )}

          <div className="border-t border-slate-800 pt-2">
            <div
              className={cx('flex items-center', expanded ? 'gap-2.5 px-2 py-1' : 'justify-center')}
              title={expanded ? undefined : `${user.name} · ${user.role}`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700 text-[11px] font-semibold text-white">
                {initials}
              </div>
              {expanded && (
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">{user.name}</p>
                  <p className="truncate text-[11px] text-slate-400 capitalize">{user.role}</p>
                </div>
              )}
            </div>

            <button
              onClick={logout}
              title={t('Log out')}
              aria-label={t('Log out')}
              className={cx(
                'mt-1 flex h-9 w-full items-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white',
                expanded ? 'gap-3 px-3' : 'justify-center',
              )}
            >
              <LogOut size={17} />
              {expanded && <span className="text-sm font-medium">{t('Log out')}</span>}
            </button>
          </div>
        </div>
      </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/*
         * The bar that stands in for the rail.
         *
         * On a small screen it is the only way out of a page, so it is always
         * there. On a wide one it appears only where the rail has been put away
         * — the register — and carries the way to bring it back, because a menu
         * that hid itself with no visible handle is a menu somebody has lost.
         */}
        <div
          className={cx(
            'no-print flex shrink-0 items-center gap-1.5 border-b border-slate-200 bg-white px-2 py-1.5',
            showRail && 'lg:hidden',
          )}
        >
          <NavLink
            to="/menu"
            className="flex h-10 items-center gap-2 rounded-xl px-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
          >
            <MenuIcon size={20} aria-hidden="true" />
            <span className="hidden sm:inline">{t('Menu')}</span>
          </NavLink>

          {/*
           * Which shop this is, wherever the rail is not.
           *
           * It changes the meaning of every figure under it — the stock on the
           * tiles, the drawer, the takings — so a register with no rail must
           * not also be a register with no way to tell, or to change it.
           */}
          <div className="w-40 shrink-0 sm:w-48 [&>*]:mb-0">
            <BranchSwitcher expanded />
          </div>

          {onRegister && (
            <button
              onClick={() => setRailOnRegister((v) => !v)}
              title={railOnRegister ? t('Hide the menu') : t('Show the menu')}
              aria-label={railOnRegister ? t('Hide the menu') : t('Show the menu')}
              className="hidden h-10 items-center rounded-xl px-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 lg:flex"
            >
              {railOnRegister ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
          )}

          <span className="ms-auto truncate text-sm font-medium text-slate-500">{user.name}</span>

          {/* The way out. Only ever in the rail before, which on a screen with
              no rail meant a till nobody could hand over at the end of a shift. */}
          <button
            onClick={logout}
            title={t('Log out')}
            aria-label={t('Log out')}
            className="flex h-10 shrink-0 items-center rounded-xl px-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-red-700"
          >
            <LogOut size={18} />
          </button>
        </div>

        {/* Above everything, because it changes what the next press means. */}
        <OfflineBar />
        {/*
         * Back, and the pages that are open. Between the header and the page,
         * so it is in the same place on every screen — a control that moves is
         * a control that has to be found again each time.
         */}
        <TabBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
    </TabsProvider>
  );
}
