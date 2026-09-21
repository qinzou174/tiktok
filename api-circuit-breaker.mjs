export class ApiCircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 180_000, now = () => Date.now(), onStateChange = () => {} } = {}) {
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 3);
    this.cooldownMs = Math.max(1_000, Number(cooldownMs) || 180_000);
    this.now = now;
    this.onStateChange = onStateChange;
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpen = false;
  }

  beforeRequest() {
    const now = this.now();
    if (this.openUntil > now) {
      const error = new Error(`远梦服务已暂停请求，约 ${Math.ceil((this.openUntil - now) / 1000)} 秒后探测恢复`);
      error.retryable = true;
      error.code = "API_CIRCUIT_OPEN";
      error.retryAfterMs = this.openUntil - now;
      throw error;
    }
    if (this.openUntil) this.halfOpen = true;
  }

  success() {
    if (!this.failures && !this.openUntil && !this.halfOpen) return;
    this.failures = 0;
    this.openUntil = 0;
    this.halfOpen = false;
    this.onStateChange(this.state());
  }

  infrastructureFailure() {
    this.failures += 1;
    if (this.halfOpen || this.failures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.halfOpen = false;
    }
    this.onStateChange(this.state());
  }

  state() {
    const now = this.now();
    return {
      status: this.openUntil > now ? "open" : this.openUntil ? "half-open" : "closed",
      failures: this.failures,
      openUntil: this.openUntil ? new Date(this.openUntil).toISOString() : null,
    };
  }
}
