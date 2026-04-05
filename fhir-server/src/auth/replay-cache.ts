export class TtlReplayCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  consume(key: string, expiresAtEpochSeconds: number) {
    const now = this.nowMs();
    this.evictExpired(now);

    const existingExpiryMs = this.entries.get(key);
    if (existingExpiryMs && existingExpiryMs > now) return false;

    const expiresAtMs = expiresAtEpochSeconds * 1000;
    this.entries.set(key, expiresAtMs);
    return true;
  }

  size() {
    this.evictExpired(this.nowMs());
    return this.entries.size;
  }

  private evictExpired(nowMs: number) {
    for (const [key, expiresAtMs] of this.entries.entries()) {
      if (expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }
}
