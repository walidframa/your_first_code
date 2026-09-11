/** Every line of one product across a list of sales, newest sale first. */
export function historyOf(orders) {
  return (orders || []).flatMap((o) => (o.lines || []).map((line) => ({ order: o, line })));
}
