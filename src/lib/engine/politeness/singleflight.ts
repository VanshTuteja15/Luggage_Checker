/* ------------------------------------------------------------------ */
/*  Single-flight with a short sharing window                         */
/*                                                                     */
/*  "Every request for current prices triggers fresh verification of   */
/*  the listings it shows, shared within a 90-second single-flight     */
/*  window." Two people searching the same bag at the same moment cost  */
/*  the store one request, and both see the same honest timestamp.      */
/* ------------------------------------------------------------------ */

export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();
  private done = new Map<string, { at: number; value: T }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 5_000,
  ) {}

  /**
   * Run `fn` once per key: concurrent callers share the in-flight promise,
   * and later callers within the window reuse the finished value when
   * `keep(value)` says it's worth keeping (failures are never shared).
   */
  async run(
    key: string,
    fn: () => Promise<T>,
    keep: (v: T) => boolean = () => true,
  ): Promise<{ value: T; shared: boolean }> {
    const hit = this.done.get(key);
    if (hit && this.now() - hit.at < this.windowMs) return { value: hit.value, shared: true };

    const pending = this.inflight.get(key);
    if (pending) return { value: await pending, shared: true };

    const p = fn();
    this.inflight.set(key, p);
    try {
      const value = await p;
      if (this.windowMs > 0 && keep(value)) {
        this.done.set(key, { at: this.now(), value });
        this.evict();
      }
      return { value, shared: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  private evict(): void {
    if (this.done.size <= this.maxEntries) return;
    const cutoff = this.now() - this.windowMs;
    for (const [k, v] of this.done) if (v.at < cutoff) this.done.delete(k);
    // Still too many: drop the oldest insertions.
    while (this.done.size > this.maxEntries) {
      const first = this.done.keys().next().value;
      if (first === undefined) break;
      this.done.delete(first);
    }
  }
}
