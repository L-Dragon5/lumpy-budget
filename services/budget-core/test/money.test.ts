import { expect, test } from "bun:test";
import { allocate, divRound, formatCents, sum } from "../src/money";

test("allocate never loses or invents a penny", () => {
  expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  expect(sum(allocate(100, [1, 1, 1]))).toBe(100);
  for (const total of [1, 7, 99, 100001, 123457]) {
    for (const weights of [[1, 1], [1, 1, 1], [3, 1], [5, 5, 5, 5, 5, 5, 5]]) {
      expect(sum(allocate(total, weights))).toBe(total);
    }
  }
});

test("allocate splits in proportion to the weights", () => {
  expect(allocate(100000, [200000, 100000])).toEqual([66667, 33333]);
  expect(sum(allocate(100000, [200000, 100000]))).toBe(100000);
});

test("allocate handles negatives and degenerate weights", () => {
  expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  expect(sum(allocate(-100, [1, 1, 1]))).toBe(-100);
  expect(allocate(100, [0, 0])).toEqual([50, 50]);
  expect(allocate(7, [])).toEqual([]);
  expect(sum(allocate(10, [0, 5]))).toBe(10);
});

test("divRound rounds away from zero, symmetrically", () => {
  expect(divRound(5, 2)).toBe(3);
  expect(divRound(-5, 2)).toBe(-3);
  expect(divRound(120000, 12)).toBe(10000);
  expect(divRound(100, 3)).toBe(33);
  expect(() => divRound(1, 0)).toThrow();
});

test("formatCents is for eyes only", () => {
  expect(formatCents(123456)).toBe("$1,234.56");
  expect(formatCents(-500)).toBe("-$5.00");
  expect(formatCents(0)).toBe("$0.00");
});
