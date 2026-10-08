import { expect, test } from "bun:test";
import { drawJobId, isJobId } from "../../src/job/id";

test("a drawn job ID is 8 lowercase hexadecimal characters", async () => {
  for (let i = 0; i < 50; i++) expect(await drawJobId(async () => false)).toMatch(/^[0-9a-f]{8}$/);
});

test("isJobId accepts only 8 lowercase hexadecimal characters", () => {
  expect(["3f9a2c1d", "00000000"].map(isJobId)).toEqual([true, true]);
  expect(["3F9A2C1D", "3f9a2c1", "3f9a2c1d0", "../a2c1d", "3f9a2c1g", 12345678].map(isJobId)).toEqual([
    false, false, false, false, false, false,
  ]);
});

test("an ID in use is drawn again", async () => {
  const draws = ["11111111", "22222222", "33333333"];
  const asked: string[] = [];
  const id = await drawJobId(
    async (candidate) => (asked.push(candidate), candidate !== "33333333"),
    () => draws.shift()!,
  );
  expect(id).toBe("33333333");
  expect(asked).toEqual(["11111111", "22222222", "33333333"]);
});

test("after five IDs in use, relay stops", async () => {
  let draws = 0;
  const attempt = drawJobId(async () => true, () => (draws++, "11111111"));
  await expect(attempt).rejects.toThrow("relay drew 5 job IDs that were all in use.");
  expect(draws).toBe(5);
});
