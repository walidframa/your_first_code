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
  Receipt,
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
function NavItem({ to, label, icon: Icon, end, expanded, dense = false }) {
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
          expanded ? cx(dense ? 'h-9' : 'h-10', 'gap-3 px-3') : 'h-11 justify-center px-0',
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
  const isAdmin = user?.role === 'admin';
  const counter = allowedItems(COUNTER_NAV, can, hasModule, isAdmin);
  const admin = allowedGroups(can, hasModule, isAdmin);

  /*
   * The whole rail is one accordion, counter included.
   *
   * With the counter's six rows pinned above it, the groups underneath were
   * left about two hundred and fifty pixels on a laptop — so opening Stock
   * showed three of its seven screens and the rest were below the fold. The
   * fold was the thing being complained about, and moving it down by a row was
   * never going to fix it.
   *
   * Register stays out of the fold, because it is the screen this app is for
   * and burying it behind a chevron to tidy a menu would be a poor trade. The
   * rest of the counter's work — the agency desk, the voucher book, today's
   * sales, a customer's logins — is reached a few times a day rather than
   * constantly, and folds like everything else.
   */
  const [pinned, ...counterRest] = counter;
  const groups =
    counterRest.length > 0
      ? [{ heading: 'Counter', icon: Receipt, items: counterRest }, ...admin]
      : admin;

  /*
   * Which back-office group is open — one of them, at most.
   *
   * An accordion rather than four independent folds, and the reason is the
   * complaint that produced it: with all four open the rail is twenty-odd rows
   * and the last of them is below the fold, so reaching Settings means
   * scrolling a menu. One open at a time and the rail always fits the screen,
   * whatever the shop has bought.
   *
   * It costs a click when you genuinely want two groups at once, which is rare:
   * a shop lives on three or four screens and visits the rest once a month.
   */
  const holdsCurrentPage = (group) =>
    group.items.some((item) =>
      item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`),
    );

  const [openGroup, setOpenGroup] = useState(
    () => localStorage.getItem('pos_nav_group') || null,
  );

  useEffect(() => {
    if (openGroup) localStorage.setItem('pos_nav_group', openGroup);
    else localStorage.removeItem('pos_nav_group');
  }, [openGroup]);

  /*
   * Arriving at a screen opens the group holding it.
   *
   * Otherwise the page you are looking at is missing from the menu and the way
   * back is a guess — and with only one group open, that would be the usual
   * case rather than the odd one.
   */
  const current = groups.find(holdsCurrentPage)?.heading ?? null;
  useEffect(() => {
    if (current) setOpenGroup(current);
  }, [current]);

  const toggleGroup = (heading) =>
    setOpenGroup((prev) => (prev === heading ? null : heading));

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
       * Past the menu, in one key.
       *
       * The rail is a dozen links, and every one of them stands between a
       * keyboard and the till. Off-screen until it is focused, which is the
       * first thing Tab reaches — so it costs a mouse nothing and saves a
       * keyboard the whole rail, on every screen.
       */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to the page
      </a>
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
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
              Front Desk
            </span>
          )}
          {/* Wide, it sits beside the name and costs no row. Narrow there is no
              room next to the logo, so it keeps its own line below — it is the
              only way back to the wide rail and must not be hard to find. */}
          {expanded && (
            <button
              onClick={() => setExpanded(false)}
              aria-label={t('Collapse the menu')}
              title={t('Collapse the menu')}
              className="shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white"
            >
              <PanelLeftClose size={17} />
            </button>
          )}
        </div>

        {!expanded && (
          <button
            onClick={() => setExpanded(true)}
            aria-label={t('Expand the menu')}
            title={t('Expand the menu')}
            className="mb-2 flex h-9 w-full items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-800 hover:text-white"
          >
            <PanelLeftOpen size={17} />
          </button>
        )}

        <BranchSwitcher expanded={expanded} />

        <nav className="flex w-full flex-col gap-1">
          {/* The same list at a size a finger can land on. Kept at the top of
              the rail rather than buried in the back office, because on a touch
              screen it is the menu somebody actually uses. */}
          <NavItem to="/menu" label="Menu" icon={LayoutGrid} expanded={expanded} />
          {pinned && <NavItem {...pinned} expanded={expanded} />}
        </nav>

        {/* The rail scrolls rather than squashing: a shorter screen must not
            cut the last group off with no way to reach it. */}
        {groups.length > 0 && (
          <div className="relative mt-2 min-h-0 w-full flex-1">
            <div className="h-full space-y-1 overflow-y-auto pb-3">
              {groups.map((group) => {
                /*
                 * Only foldable in the wide rail. Narrow, there is no room for
                 * a name beside the chevron, and a toggle with no name on it is
                 * a button nobody presses twice — so the icons are simply all
                 * shown, separated by a rule.
                 */
                const foldable = expanded;
                const open = !foldable || openGroup === group.heading;
                const GroupIcon = group.icon;
                const holdsPage = holdsCurrentPage(group);

                return (
                  <nav key={group.heading} className="flex w-full flex-col gap-1">
                    {foldable ? (
                      /*
                       * A row, the same shape as the rows under it, rather than
                       * a grey caption. A heading that looks like a label is a
                       * label; a heading that looks like the things around it,
                       * with a chevron on the end, is a thing you press — and
                       * this one has to be pressed to reach half the app.
                       */
                      <button
                        onClick={() => toggleGroup(group.heading)}
                        aria-expanded={open}
                        className={cx(
                          'group flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium transition',
                          open
                            ? 'bg-slate-800 text-white'
                            : 'text-slate-400 hover:bg-slate-800 hover:text-white',
                        )}
                      >
                        {GroupIcon && <GroupIcon size={18} className="shrink-0" aria-hidden="true" />}
                        <span className="min-w-0 flex-1 truncate text-left">{t(group.heading)}</span>
                        {/* Closed over the page you are on: a dot, so a folded
                            group still says "it is in here". */}
                        {!open && holdsPage && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                        )}
                        <ChevronRight
                          size={14}
                          className={cx('shrink-0 transition-transform', open && 'rotate-90')}
                          aria-hidden="true"
                        />
                      </button>
                    ) : (
                      <div className="mx-3 mb-1 border-t border-slate-700/70" aria-hidden="true" />
                    )}
                    {open &&
                      group.items.map((item) => (
                        /* Stepped in under their heading, so the shape of the
                           menu says which rows belong to what. */
                        <div key={item.to} className={cx(foldable && 'ps-3')}>
                          <NavItem {...item} expanded={expanded} dense={foldable} />
                        </div>
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

      <main id="main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
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
            /*
             * Gone where the rail says everything this bar says — except on the
             * register, where it says one thing the rail does not: the drawer.
             *
             * Reported from the counter with a photograph: a laptop with the
             * menu showing had no till figure on the register at all, and no
             * way to open the cashbox, because the strip carrying them was
             * hidden the moment the rail appeared. What is duplicated hides
             * below; what is not, stays.
             */
            showRail && !onRegister && 'lg:hidden',
          )}
        >
          <NavLink
            to="/menu"
            className={cx(
              'flex h-10 items-center gap-2 rounded-xl px-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100',
              showRail && 'lg:hidden',
            )}
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
          {/*
           * The one thing on this bar that gives way.
           *
           * It and the drawer chip were fighting over the same forty pixels on
           * a phone — worse with the bigger-text setting on — and the drawer was
           * winning by drawing on top of the name. Something has to yield, and
           * a shop name shortened to "Main bra…" still says which shop; a till
           * figure shortened to "$8…" says nothing at all.
           */}
          <div
            className={cx(
              'max-w-[8rem] min-w-0 flex-1 sm:w-48 sm:max-w-none sm:flex-none [&>*]:mb-0',
              // The rail carries the same switcher, and two of them on one
              // screen is two things to wonder about.
              showRail && 'lg:hidden',
            )}
          >
            <BranchSwitcher expanded />
          </div>

          {/*
           * Where the register hangs its drawer and its profit.
           *
           * A slot rather than the panel itself: the figures have to follow the
           * till without a reload, which means they belong to the page that
           * knows a sale just happened. The register portals into this — see
           * Checkout — so the state stays where it is understood and only the
           * pixels move up here, next to the shop's name, where the rest of
           * "which shop, whose money" already lives.
           */}
          <div id="pos-header-slot" className="flex min-w-0 items-center gap-2" />

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

          {/*
           * Who is signed in, and the way out — kept together at the end of the
           * bar so neither can be pushed off it.
           *
           * The name goes on a phone. It is on the menu page, one press away,
           * and a bar that overlaps itself is worse than a bar that says less:
           * the way out is what has to survive, because a till nobody can hand
           * over at the end of a shift is a real problem and a missing name is
           * not.
           */}
          <div
            className={cx(
              'ms-auto flex min-w-0 items-center gap-1',
              // Also in the rail, at the foot of it.
              showRail && 'lg:hidden',
            )}
          >
            <span className="hidden truncate text-sm font-medium text-slate-500 sm:block">
              {user.name}
            </span>
            <button
              onClick={logout}
              title={t('Log out')}
              aria-label={t('Log out')}
              className="flex h-10 shrink-0 items-center rounded-xl px-2.5 text-slate-500 transition hover:bg-slate-100 hover:text-red-700"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>

        {/* Above everything, because it changes what the next press means. */}
        <OfflineBar />
        {/*
         * Back, and the pages that are open. Between the header and the page,
         * so it is in the same place on every screen — a control that moves is
         * a control that has to be found again each time.
         *
         * Every screen except the register. That one is a counter, not a page:
         * it wants the whole window, it already has its own way back to the
         * menu, and a row of other places to be is the last thing wanted above
         * a cart with a customer waiting on the other side of it.
         */}
        {!onRegister && <TabBar />}
        {/*
         * Keyed on the path so the arrival plays again on each navigation —
         * without the key React reuses the node and the animation runs once,
         * on the first screen of the session, and never after.
         */}
        <div key={pathname} className="animate-page-in min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
    </TabsProvider>
  );
}
