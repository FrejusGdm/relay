import { expect, test } from "bun:test";
import { JobQueue } from "../src/queue.ts";

test("Enqueued jobs receive distinct IDs", () => {
  const queue = new JobQueue();
  expect(queue.enqueue("email", {})).not.toBe(queue.enqueue("email", {}));
});

test("The oldest queued job runs first with its payload", async () => {
  const queue = new JobQueue();
  const first = queue.enqueue("email", { to: "a@example.com" });
  queue.enqueue("email", { to: "b@example.com" });
  let received: unknown;
  const job = await queue.runNext({ email: (payload) => { received = payload; } });
  expect(job?.id).toBe(first);
  expect(received).toEqual({ to: "a@example.com" });
});

test("A successful job is done after one attempt", async () => {
  const queue = new JobQueue();
  const id = queue.enqueue("email", {});
  await queue.runNext({ email: () => {} });
  expect(queue.get(id)?.status).toBe("done");
  expect(queue.get(id)?.attempts).toBe(1);
});

test("An empty queue has no next job", async () => {
  expect(await new JobQueue().runNext({})).toBeUndefined();
});
