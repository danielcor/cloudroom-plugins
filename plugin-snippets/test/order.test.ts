import { describe, expect, it } from "vitest";
import { compareOrder, nextOrder, planMove, type Ordered } from "../src/order.js";

const items = (...orders: (number | null)[]): Ordered[] => orders.map((order, i) => ({ id: `s${i}`, order }));

describe("reorder maths", () => {
  it("moves into a gap with one write", () => {
    // s0:10 s1:20 s2:30 → move s2 between s0 and s1
    expect(planMove(items(10, 20, 30), "s2", 1)).toEqual([{ id: "s2", order: 15 }]);
  });

  it("moves to the ends with one write", () => {
    expect(planMove(items(10, 20, 30), "s0", 2)).toEqual([{ id: "s0", order: 40 }]);
    expect(planMove(items(10, 20, 30), "s2", 0)).toEqual([{ id: "s2", order: 0 }]);
  });

  it("does nothing when the position does not change", () => {
    expect(planMove(items(10, 20, 30), "s1", 1)).toEqual([]);
  });

  it("clamps the target index", () => {
    expect(planMove(items(10, 20, 30), "s0", 99)).toEqual([{ id: "s0", order: 40 }]);
  });

  it("renumbers the scope only when the gap runs out", () => {
    // s0:10 s1:11 s2:12 → move s2 between s0 and s1: no integer between 10 and 11
    expect(planMove(items(10, 11, 12), "s2", 1)).toEqual([
      { id: "s2", order: 20 },
      { id: "s1", order: 30 },
    ]);
  });

  it("renumbers when hand-written files have no order", () => {
    expect(planMove(items(10, null, null), "s2", 0)).toEqual([
      { id: "s2", order: 10 },
      { id: "s0", order: 20 },
      { id: "s1", order: 30 },
    ]);
  });

  it("sorts missing orders last and appends after the max", () => {
    const list = [{ id: "b", order: null }, { id: "a", order: 20 }, { id: "c", order: 5 }, { id: "a2", order: null }];
    expect([...list].sort(compareOrder).map((i) => i.id)).toEqual(["c", "a", "a2", "b"]);
    expect(nextOrder(list)).toBe(30);
    expect(nextOrder([])).toBe(10);
  });

  it("rejects an unknown id", () => {
    expect(() => planMove(items(10), "nope", 0)).toThrow("unknown snippet nope");
  });
});
