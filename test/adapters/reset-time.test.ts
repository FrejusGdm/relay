import { afterAll, describe, expect, test } from "bun:test";
import { resetTimeFromText, resetTimeFromValue } from "../../src/adapters/reset-time";
import { setClock } from "../../src/platform/clock";

const savedZone = process.env.TZ;
afterAll(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
  setClock(null);
});

test("numbers below 10^12 are seconds, larger numbers milliseconds, strings ISO 8601", () => {
  const reset = new Date("2026-10-07T15:45:00Z");
  expect(resetTimeFromValue(1791387900)).toEqual(reset);
  expect(resetTimeFromValue(1791387900000)).toEqual(reset);
  expect(resetTimeFromValue("2026-10-07T15:45:00Z")).toEqual(reset);
  expect(resetTimeFromValue("2026-10-07T17:45:00+02:00")).toEqual(reset);
  for (const value of ["soon", "1791387900", "Oct 9, 3:45 PM", Number.NaN, Number.POSITIVE_INFINITY, 1e20, -1, 0, null, undefined, {}]) {
    expect(resetTimeFromValue(value)).toBeUndefined();
  }
});

const ZONES = {
  "Europe/Paris": [
    // Wednesday 2026-10-07, 15:00 in Paris (UTC+2).
    ["2026-10-07T13:00:00Z", "3:45pm", "2026-10-07T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "3:45 PM", "2026-10-07T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "3:45 PM.", "2026-10-07T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "4pm (Europe/Paris)", "2026-10-07T14:00:00Z"],
    ["2026-10-07T13:00:00Z", " 3:45 PM (Europe/Paris). ", "2026-10-07T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "2:00pm", "2026-10-08T12:00:00Z"],
    ["2026-10-07T13:00:00Z", "3:00pm", "2026-10-08T13:00:00Z"],
    ["2026-10-07T13:00:00Z", "12:00pm", "2026-10-08T10:00:00Z"],
    ["2026-10-07T13:00:00Z", "Mon 12:00am", "2026-10-11T22:00:00Z"],
    ["2026-10-07T13:00:00Z", "Wed 3:45pm", "2026-10-07T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "Wed 2:45pm", "2026-10-14T12:45:00Z"],
    ["2026-10-07T13:00:00Z", "Oct 9, 3:45 PM", "2026-10-09T13:45:00Z"],
    ["2026-10-07T13:00:00Z", "Oct 5, 3:45 PM", "2027-10-05T13:45:00Z"],
    // Saturday 2026-10-10, the weekly-limit scenario of the claude-code-adapter spec.
    ["2026-10-10T10:00:00Z", "Mon 12:00am", "2026-10-11T22:00:00Z"],
    // Summer time ends in Paris on 2026-10-25, so the next 3:45pm is at UTC+1.
    ["2026-10-24T20:00:00Z", "3:45pm", "2026-10-25T14:45:00Z"],
  ],
  "America/Los_Angeles": [
    // Wednesday 2026-10-07, 13:00 in Los Angeles (UTC-7).
    ["2026-10-07T20:00:00Z", "3:45pm", "2026-10-07T22:45:00Z"],
    ["2026-10-07T20:00:00Z", "3:45 PM", "2026-10-07T22:45:00Z"],
    ["2026-10-07T20:00:00Z", "Mon 12:00am", "2026-10-12T07:00:00Z"],
    ["2026-10-07T20:00:00Z", "Oct 9, 3:45 PM", "2026-10-09T22:45:00Z"],
    // Summer time ends in Los Angeles on 2026-11-01, so Monday midnight is at UTC-8.
    ["2026-10-31T20:00:00Z", "Mon 12:00am", "2026-11-02T08:00:00Z"],
  ],
} as const;

for (const [zone, cases] of Object.entries(ZONES)) {
  describe(`local reset times with TZ=${zone}`, () => {
    for (const [at, text, expected] of cases) {
      test(`"${text}" at ${at} is ${expected}`, () => {
        process.env.TZ = zone;
        expect(resetTimeFromText(text, new Date(at))).toEqual(new Date(expected));
        setClock(() => new Date(at));
        expect(resetTimeFromText(text)).toEqual(new Date(expected));
      });
    }
  });
}

test("text in another form gives no time", () => {
  process.env.TZ = "Europe/Paris";
  const at = new Date("2026-10-07T13:00:00Z");
  for (const text of ["15:45", "13:00pm", "3:60pm", "soon", "Feb 30, 3:45 PM", "Someday 3:45pm", ""]) {
    expect(resetTimeFromText(text, at)).toBeUndefined();
  }
});
