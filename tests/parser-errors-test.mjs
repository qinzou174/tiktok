import assert from "node:assert/strict";
import { isParserInfrastructureFailure } from "../parser-errors.mjs";

for (const message of [
  "The platform flagged the request as automated traffic; the identity has been cooled down.",
  "No identity is available; the pool is expected to recover in 10 seconds.",
  "Failed to connecting to 8.134.172.132 port 5558, Connection timed out",
]) {
  assert.equal(isParserInfrastructureFailure(message), true, message);
}

for (const message of ["作品不存在", "无效链接", "解析成功"]) {
  assert.equal(isParserInfrastructureFailure(message), false, message);
}

console.log("parser-errors-test: ok");
