// 简单的顺序限流器：确保连续请求至少间隔 minGapMs
class RateLimiter {
  constructor(minGapMs = 200) {
    this.minGapMs = minGapMs;
    this.lastStart = 0;
    this.queue = Promise.resolve();
  }

  async wait() {
    const run = this.queue.then(async () => {
      const now = Date.now();
      const waitMs = this.lastStart + this.minGapMs - now;
      if (waitMs > 0) {
        await new Promise((res) => setTimeout(res, waitMs));
      }
      this.lastStart = Date.now();
    });
    // 防止链路因异常中断
    this.queue = run.catch(() => {});
    return run;
  }
}

module.exports = RateLimiter;

