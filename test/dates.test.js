import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, isBareDay, localDay, localStamp, parseArgDate, parseEkDate } from "../src/lib/dates.js";
import { UserError } from "../src/lib/errors.js";

test("date only", () => {
  const p = parseEkDate("2030-03-05");
  assert.equal(p.dateOnly, true);
  assert.equal(localStamp(p.date), "2030-03-05 00:00");
});

test("12 hour format from the EventKit helper", () => {
  assert.equal(localStamp(parseEkDate("2030-10-02 10:00:00 AM").date), "2030-10-02 10:00");
  assert.equal(localStamp(parseEkDate("2030-10-02 12:30:00 PM").date), "2030-10-02 12:30");
  assert.equal(localStamp(parseEkDate("2030-10-02 12:15:00 AM").date), "2030-10-02 00:15");
  assert.equal(localStamp(parseEkDate("2030-10-02 9:05:00 pm").date), "2030-10-02 21:05");
});

test("local 24 hour and ISO forms", () => {
  assert.equal(localStamp(parseEkDate("2030-10-02 18:00").date), "2030-10-02 18:00");
  assert.equal(localStamp(parseEkDate("2030-10-02T18:00:30").date), "2030-10-02 18:00");
  assert.equal(parseEkDate("2030-10-02T16:00:00Z").date.getTime(), Date.UTC(2030, 9, 2, 16));
});

test("rejects impossible and unreadable dates", () => {
  assert.equal(parseEkDate("2030-02-30"), null);
  assert.equal(parseEkDate("2030-02-30 10:00"), null);
  assert.equal(parseEkDate("not a date"), null);
  assert.equal(parseEkDate(""), null);
  assert.equal(parseEkDate(null), null);
});

test("parseArgDate throws a UserError naming the argument", () => {
  assert.equal(parseArgDate(undefined, "since"), null);
  assert.throws(() => parseArgDate("tomorrowish", "since"), (e) => e instanceof UserError && /since/.test(e.message));
});

test("addDays keeps calendar days across month ends", () => {
  assert.equal(localDay(addDays(new Date(2030, 0, 31), 1)), "2030-02-01");
  assert.equal(localDay(addDays(new Date(2030, 2, 1), -1)), "2030-02-28");
});

test("isBareDay", () => {
  assert.equal(isBareDay("2030-01-01"), true);
  assert.equal(isBareDay(" 2030-01-01 "), true);
  assert.equal(isBareDay("2030-01-01 10:00"), false);
  assert.equal(isBareDay(undefined), false);
});
