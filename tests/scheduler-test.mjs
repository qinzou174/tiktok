import assert from "node:assert/strict";
import { ApiRequestScheduler } from "../api-scheduler.mjs";

const starts = [];
let active = 0;
let maxActive = 0;
const scheduler = new ApiRequestScheduler({
  minIntervalMs: 30,
  execute: async (name) => {
    starts.push({ name, at: Date.now() });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active -= 1;
    return name;
  },
});

const first = scheduler.schedule("first", "fresh");
const retry = scheduler.schedule("retry", "retry");
const fresh = scheduler.schedule("fresh", "fresh");
assert.deepEqual(await Promise.all([first, retry, fresh]), ["first", "retry", "fresh"]);
assert.deepEqual(starts.map((item) => item.name), ["first", "fresh", "retry"]);
assert.equal(maxActive, 1);
for (let index = 1; index < starts.length; index += 1) {
  assert.ok(starts[index].at - starts[index - 1].at >= 25, `start gap ${index} was too short`);
}
assert.deepEqual(scheduler.state(), { active: false, freshWaiting: 0, retryWaiting: 0 });
console.log("scheduler-test: ok");
