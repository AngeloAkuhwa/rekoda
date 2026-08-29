import { Injectable } from '@nestjs/common';

/**
 * A bounded, in-process count of rejected webhook signatures (S1, PR-108).
 *
 * The two webhook endpoints reject a bad signature BEFORE persistence, and
 * deliberately so: they are world-reachable and unauthenticated, so storing
 * the payload would hand anyone an unbounded write. The consequence was that
 * the ops health probe's `badSignatures` read `signature_valid = 0` from a
 * column no code ever writes - a permanent, structurally-guaranteed zero
 * that reads as "nobody is probing us" even mid-attack, or during a secret
 * rotation that is silently 401-ing every real merchant message.
 *
 * This is the honest alternative: a counter, not a payload. It costs one
 * integer per provider per process and no database write, so it cannot be a
 * flood vector. It resets on restart, which is the right granularity for an
 * attack signal - a spike within a process lifetime is what an operator
 * alarms on - and each replica reports its own, so a nonzero on any is the
 * signal.
 */
@Injectable()
export class SecurityMetrics {
  private readonly rejected = new Map<string, number>();

  /** Record one webhook rejected for a bad or missing signature. */
  rejectedSignature(provider: string): void {
    this.rejected.set(provider, (this.rejected.get(provider) ?? 0) + 1);
  }

  /** How many this process has rejected for `provider` since it started. */
  rejectedSignatures(provider: string): number {
    return this.rejected.get(provider) ?? 0;
  }
}
