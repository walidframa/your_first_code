/**
 * What a phone shop sells, as the shelves it sells it from.
 *
 * A brand-new shop opening this app for the first time finds an empty
 * catalogue and a category list with nothing in it, and the first thing it is
 * asked to do is invent a filing system for its own stock. Most shops of this
 * kind file it the same way, so here is that way, ready to be used, renamed or
 * deleted.
 *
 * Deliberately short. Twenty categories is a list nobody reads and a filter bar
 * that wraps onto three lines at the register — and a shop that needs its own
 * twenty can add them. These are the ones almost every phone and electronics
 * shop in the country actually has a shelf for.
 */
export const STARTER_CATEGORIES = [
  'Phones',
  'Tablets',
  'Laptops',
  'Smart watches',
  'Headphones',
  'Speakers',
  'Chargers',
  'Cables',
  'Power banks',
  'Cases & covers',
  'Screen protectors',
  'Memory cards',
  'SIM cards',
  'Recharge cards',
  'Accessories',
  'Second hand',
];

/**
 * Add the ones that are not already there, and leave everything else alone.
 *
 * Matched without regard to case or surrounding space, so a shop that already
 * typed "phones" is not given a second shelf called "Phones" to split its stock
 * across. Returns what was actually added, because "nothing to do" and "added
 * sixteen" should not look the same to whoever pressed the button.
 */
export function addStarterCategories(db, names = STARTER_CATEGORIES) {
  const existing = new Set(
    db
      .prepare('SELECT name FROM categories')
      .all()
      .map((row) => row.name.trim().toLowerCase()),
  );

  const insert = db.prepare('INSERT INTO categories (name) VALUES (?)');
  const added = [];
  for (const name of names) {
    if (existing.has(name.trim().toLowerCase())) continue;
    insert.run(name);
    existing.add(name.trim().toLowerCase());
    added.push(name);
  }
  return added;
}
