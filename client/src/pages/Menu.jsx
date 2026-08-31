import { Link } from 'react-router';
import { ChevronRight } from 'lucide-react';
import { useNarrow } from '../lib/screen';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { COUNTER_NAV, allowedGroups, allowedItems } from '../lib/nav';
import { useLicence } from '../context/LicenceContext';

/**
 * Everywhere you can go, as something you can hit with a thumb.
 *
 * The rail down the side is a good menu for a mouse and a poor one for a
 * finger: seventeen-pixel icons and a nine-pixel caption, on a counter screen
 * somebody is prodding between customers. This is the same list at a size a
 * hand can land on without aiming.
 *
 * It is also what the app has *instead* of a rail on a narrow screen. A menu
 * that slides over the page is a second thing to learn and a second thing to
 * get stuck open; a page is just a page, and Back works.
 *
 * Both are fed from one table, so a screen added later cannot appear in one and
 * not the other.
 */
function Tile({ to, label, icon: Icon }) {
  const t = useT();
  return (
    <Link
      to={to}
      /* The same name the rail uses, so anything looking for a screen by name
         finds it here too — and so a truncated tile still answers a hover. */
      title={t(label)}
      className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white p-5 text-center ring-1 ring-slate-900/[0.07] transition active:scale-[0.97] hover:ring-brand-300 hover:shadow-sm"
      /*
       * Big enough to hit without aiming, and big enough to read across a
       * counter. A tile the size of a fingertip is a tile you lean in to poke;
       * this is one you can hit while looking at the customer.
       */
      style={{ minHeight: '140px' }}
    >
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">
        <Icon size={32} aria-hidden="true" />
      </span>
      <span className="text-base leading-tight font-medium text-slate-800">{t(label)}</span>
    </Link>
  );
}

/**
 * The same destination as a row, for a phone.
 *
 * A 140-pixel tile is right for a counter monitor somebody prods between
 * customers — it can be hit without aiming, and read across a shop. On a
 * handset it is the wrong unit entirely: two per row means this app's thirty
 * screens are fifteen rows of scrolling to reach Settings, and the icon is
 * doing none of the work that the extra height cost.
 *
 * A row is 56 pixels, still comfortably over the 44 a thumb needs, and shows
 * six at a time in the space one tile used. Which is what every phone app does
 * with a long list of places, for this reason.
 */
function Row({ to, label, icon: Icon }) {
  const t = useT();
  return (
    <Link
      to={to}
      title={t(label)}
      className="flex min-h-[56px] items-center gap-3.5 bg-white px-4 py-3 transition active:bg-slate-100"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon size={19} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-slate-800">
        {t(label)}
      </span>
      <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden="true" />
    </Link>
  );
}

function Section({ heading, items }) {
  const t = useT();
  /* The same 640px `sm` the classes use, so what this decides and what the
     rest of the page does cannot disagree about where a phone stops. */
  const narrow = useNarrow();
  if (items.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2.5 text-xs font-semibold tracking-wider text-slate-500 uppercase">
        {t(heading)}
      </h2>
      {/*
       * Three across on a phone, more as the screen allows. Sized by the tile
       * rather than by a fixed count, so a square counter monitor and a wide
       * desk one both fill their row.
       */}
      {/*
        * One list or the other, chosen here rather than with `hidden sm:grid`.
        *
        * Two copies in the DOM with one hidden would mean every screen in this
        * app appears twice: twice to a screen reader, twice to anything looking
        * for a link by name, and sixty nodes where thirty would do. The hidden
        * half is not free just because it is not painted.
        */}
      {narrow ? (
        <div className="divide-y divide-rule overflow-hidden rounded-2xl ring-1 ring-slate-900/[0.06]">
          {items.map((item) => (
            <Row key={item.to} {...item} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {items.map((item) => (
            <Tile key={item.to} {...item} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function Menu() {
  const { user, can } = useAuth();
  const isAdmin = user?.role === 'admin';
  // Same two questions as the rail — see lib/nav.js.
  const { hasModule } = useLicence();
  const t = useT();

  return (
    <div className="h-full overflow-y-auto bg-slate-100 px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-5xl">
        {/*
         * Just the title. Which branch you are in and the way out are both on
         * the bar above this page and in the rail beside it — a third copy here
         * is two more things to read before reaching the thing you came for.
         */}
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-slate-900">{t('Menu')}</h1>
          <p className="text-sm text-slate-500">
            {user.name} · {t(user.role === 'admin' ? 'Owner' : 'Cashier')}
          </p>
        </div>

        <Section heading="Counter" items={allowedItems(COUNTER_NAV, can, hasModule, isAdmin)} />
        {allowedGroups(can, hasModule, isAdmin).map((group) => (
          <Section key={group.heading} {...group} />
        ))}
      </div>
    </div>
  );
}
