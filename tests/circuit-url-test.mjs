import assert from "node:assert/strict";
import { ApiCircuitBreaker } from "../api-circuit-breaker.mjs";
import { canonicalDouyinUrl } from "../douyin-url.mjs";

assert.equal(canonicalDouyinUrl("https://www.iesdouyin.com/share/slides/7684139766787821553/?region=CN"), "https://www.douyin.com/note/7684139766787821553");
assert.equal(canonicalDouyinUrl("https://www.douyin.com/note/7685915917502856040?previous_page=app_code_link"), "https://www.douyin.com/note/7685915917502856040");
assert.equal(canonicalDouyinUrl("https://www.douyin.com/video/7687200874925610609"), "https://www.douyin.com/video/7687200874925610609");

let now = 1_000;
const breaker = new ApiCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000, now: () => now });
breaker.infrastructureFailure();
breaker.infrastructureFailure();
assert.equal(breaker.state().status, "closed");
breaker.infrastructureFailure();
assert.equal(breaker.state().status, "open");
assert.throws(() => breaker.beforeRequest(), (error) => error.code === "API_CIRCUIT_OPEN" && error.retryAfterMs === 10_000);
now += 10_000;
breaker.beforeRequest();
assert.equal(breaker.state().status, "half-open");
breaker.success();
assert.deepEqual(breaker.state(), { status: "closed", failures: 0, openUntil: null });
console.log("circuit-url-test: ok");
