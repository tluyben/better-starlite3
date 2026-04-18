import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsyncMutex } from "../src/mutex.js";

describe("AsyncMutex", () => {
  it("runs a single task immediately", async () => {
    const mu = new AsyncMutex();
    const result = await mu.run(() => 42);
    assert.equal(result, 42);
  });

  it("serialises concurrent tasks", async () => {
    const mu = new AsyncMutex();
    const order: number[] = [];

    // Fire 5 tasks without awaiting; they must execute in submission order
    await Promise.all([
      mu.run(async () => { order.push(0); }),
      mu.run(async () => { order.push(1); }),
      mu.run(async () => { order.push(2); }),
      mu.run(async () => { order.push(3); }),
      mu.run(async () => { order.push(4); }),
    ]);

    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("unblocks next waiter after a throw", async () => {
    const mu = new AsyncMutex();
    const ran: number[] = [];

    await Promise.allSettled([
      mu.run(async () => { ran.push(1); throw new Error("boom"); }),
      mu.run(async () => { ran.push(2); }),
    ]);

    assert.deepEqual(ran, [1, 2]);
  });

  it("serialises writes while allowing parallel reads (convention check)", async () => {
    const mu = new AsyncMutex();
    let counter = 0;
    let maxConcurrent = 0;
    let concurrent = 0;

    const writes = Array.from({ length: 20 }, (_, i) =>
      mu.run(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        counter += i;
        concurrent--;
      }),
    );

    await Promise.all(writes);
    assert.equal(maxConcurrent, 1, "never more than 1 concurrent writer");
    assert.equal(counter, (19 * 20) / 2); // 0+1+…+19
  });
});
