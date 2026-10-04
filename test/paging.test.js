import assert from "node:assert/strict";
import { test } from "node:test";
import { clampInt, page } from "../src/lib/paging.js";

test("clampInt", () => {
  assert.equal(clampInt(undefined, 1, 10, 5), 5);
  assert.equal(clampInt("", 1, 10, 5), 5);
  assert.equal(clampInt("abc", 1, 10, 5), 5);
  assert.equal(clampInt(0, 1, 10, 5), 1);
  assert.equal(clampInt(99, 1, 10, 5), 10);
  assert.equal(clampInt(3.9, 1, 10, 5), 3);
});

test("page", () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(page(items, 3, 0), { total: 7, offset: 0, limit: 3, has_more: true, items: [0, 1, 2] });
  assert.deepEqual(page(items, 3, 6), { total: 7, offset: 6, limit: 3, has_more: false, items: [6] });
  assert.equal(page(items, undefined, undefined, 4).limit, 4);
});
