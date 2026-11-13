// Manual order with gaps of 10. A move rewrites only the moved snippet unless
// its neighbours leave no integer between them; then the scope is renumbered.

export const ORDER_GAP = 10;

export interface Ordered {
  id: string;
  /** null for a hand-written file with no `order` key. */
  order: number | null;
}

/** Sort by order (missing last), then by id. */
export function compareOrder(a: Ordered, b: Ordered): number {
  if (a.order === null && b.order === null) return a.id.localeCompare(b.id);
  if (a.order === null) return 1;
  if (b.order === null) return -1;
  return a.order - b.order || a.id.localeCompare(b.id);
}

/** The order for a new snippet appended at the end. */
export function nextOrder(items: readonly Ordered[]): number {
  let max = 0;
  for (const i of items) if (i.order !== null && i.order > max) max = i.order;
  return max + ORDER_GAP;
}

/**
 * Move `id` to `toIndex` in `items` (already in display order). Returns the
 * writes needed: one entry normally, every changed entry after a renumber.
 */
export function planMove(items: readonly Ordered[], id: string, toIndex: number): { id: string; order: number }[] {
  const from = items.findIndex((i) => i.id === id);
  if (from === -1) throw new Error(`unknown snippet ${id}`);
  const rest = items.filter((i) => i.id !== id);
  const to = Math.max(0, Math.min(Math.trunc(toIndex), rest.length));
  if (to === from) return [];
  const prev = rest[to - 1]?.order;
  const next = rest[to]?.order;
  const sound = rest.every((i, k) => i.order !== null && (k === 0 || i.order > rest[k - 1]!.order!));
  if (sound) {
    let order: number | null = null;
    if (next === undefined) order = (prev ?? 0) + ORDER_GAP;
    else if (prev === undefined) order = next! - ORDER_GAP;
    else if (next! - prev! >= 2) order = prev! + Math.floor((next! - prev!) / 2);
    if (order !== null) return [{ id, order }];
  }
  const arranged = [...rest];
  arranged.splice(to, 0, items[from]!);
  const writes: { id: string; order: number }[] = [];
  arranged.forEach((item, k) => {
    const order = (k + 1) * ORDER_GAP;
    if (item.order !== order) writes.push({ id: item.id, order });
  });
  return writes;
}
