export class ApiRequestScheduler {
  constructor({ execute, minIntervalMs = 1_000, onStateChange = () => {} }) {
    if (typeof execute !== "function") throw new TypeError("execute is required");
    this.execute = execute;
    this.minIntervalMs = Math.max(0, Number(minIntervalMs) || 0);
    this.onStateChange = onStateChange;
    this.fresh = [];
    this.retry = [];
    this.active = false;
    this.lastStartedAt = 0;
    this.wakeTimer = null;
  }

  schedule(input, priority = "fresh") {
    return new Promise((resolve, reject) => {
      (priority === "retry" ? this.retry : this.fresh).push({ input, resolve, reject });
      this.onStateChange(this.state());
      this.#pump();
    });
  }

  state() {
    return { active: this.active, freshWaiting: this.fresh.length, retryWaiting: this.retry.length };
  }

  #pump() {
    if (this.active || this.wakeTimer || (!this.fresh.length && !this.retry.length)) return;
    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartedAt));
    if (waitMs > 0) {
      this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.#pump(); }, waitMs);
      return;
    }
    const job = this.fresh.shift() || this.retry.shift();
    this.active = true;
    this.lastStartedAt = Date.now();
    this.onStateChange(this.state());
    Promise.resolve().then(() => this.execute(job.input)).then(job.resolve, job.reject).finally(() => {
      this.active = false;
      this.onStateChange(this.state());
      this.#pump();
    });
  }
}
