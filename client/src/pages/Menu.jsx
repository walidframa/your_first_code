import { Link } from 'react-router';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { COUNTER_NAV, allowedGroups, allowedItems } from '../lib/nav';

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
      className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-white p-4 text-center ring-1 ring-slate-900/[0.07] transition active:scale-[0.97] hover:ring-brand-300 hover:shadow-sm"
      /*
       * Tall enough to be a target rather than a link. Roughly a fingertip plus
       * the room to miss by a little, which is the difference between a till
       * somebody trusts and one they lean in to poke.
       */
      style={{ minHeight: '104px' }}
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon size={24} aria-hidden="true" />
      </span>
      <span className="text-sm leading-tight font-medium text-slate-800">{t(label)}</span>
    </Link>
  );
}

function Section({ heading, items }) {
  const t = useT();
  if (items.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">
        {t(heading)}
      </h2>
      {/*
       * Three across on a phone, more as the screen allows. Sized by the tile
       * rather than by a fixed count, so a square counter monitor and a wide
       * desk one both fill their row.
       */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2.5">
        {items.map((item) => (
          <Tile key={item.to} {...item} />
        ))}
      </div>
    </section>
  );
}

export default function Menu() {
  const { user, can } = useAuth();
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

        <Section heading="Counter" items={allowedItems(COUNTER_NAV, can)} />
        {allowedGroups(can).map((group) => (
          <Section key={group.heading} {...group} />
        ))}
      </div>
    </div>
  );
}
