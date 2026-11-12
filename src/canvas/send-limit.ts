/** @fileoverview A small token bucket per conversation, so a loop (an agent messaging a conversation again and again) is slowed to a trickle and answered 429. Pure apart from the injected clock. */
export type Bucket = { tokens: number; at: number };
/** Burst and refill per minute: an agent gets fewer than a person. */
export const AGENT_LIMIT = { burst: 3, perMinute: 6 } as const;
export const HUMAN_LIMIT = { burst: 6, perMinute: 12 } as const;
const MAX_BUCKETS = 500;

export class SendLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private now: () => number = Date.now) {}
  /** Takes one token; false when the bucket is empty. */
  take(key: string, agent: boolean): boolean {
    const limit = agent ? AGENT_LIMIT : HUMAN_LIMIT;
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: limit.burst, at: t };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((t - bucket.at) / 60_000) * limit.perMinute);
    bucket.at = t;
    this.buckets.delete(key);
    if (this.buckets.size >= MAX_BUCKETS) this.buckets.delete(this.buckets.keys().next().value!);
    this.buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
  clear(): void {
    this.buckets.clear();
  }
}
