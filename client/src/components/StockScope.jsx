import { useBranch } from '../context/BranchContext';
import { cx } from './ui';

/**
 * Whose shelf a stock figure is for.
 *
 * The branch switcher at the top changes the whole app — which till, which
 * sales, which cashbox. Somebody looking at the products page only wants
 * to *look* at the other shop's shelf, or at both together, without moving
 * everything else across town. So the lists that show a quantity get their
 * own picker: this branch, one of the others, or all of them side by side.
 *
 * `value` is 'here' (the branch the app is on), 'all', or a branch id as a
 * string. Nothing is drawn for a shop with one branch, or for somebody who
 * may not see the others — the server would refuse them anyway.
 */
export const stockScopeParams = (scope) =>
  scope === 'all' ? { branch: 'all' } : scope && scope !== 'here' ? { branchId: scope } : {};

export default function StockScope({ value, onChange, className }) {
  const { branch, branches, canSwitch, total } = useBranch();
  if (!canSwitch || total < 2) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Stock at"
      title="Which branch's stock to show"
      data-stock-scope
      className={cx(
        'h-8 shrink-0 rounded-lg bg-slate-100 px-2 text-xs font-medium text-slate-700 ring-1 ring-transparent focus:bg-white focus:ring-brand-600 focus:outline-none',
        className,
      )}
    >
      <option value="here">Stock at {branch?.name || 'this branch'}</option>
      {branches
        .filter((b) => b.id !== branch?.id)
        .map((b) => (
          <option key={b.id} value={String(b.id)}>
            Stock at {b.name}
          </option>
        ))}
      <option value="all">Stock at all branches</option>
    </select>
  );
}
