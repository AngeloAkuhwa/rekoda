import { capabilitiesFor, hasCapability, type Capability, type EntitlementKey } from '@rekoda/core';
import type { MeResponse } from '@rekoda/contracts';

/**
 * What this signed-in merchant can do.
 *
 * One helper so no page reimplements the question, and so none of them reads
 * a plan NAME to answer it. `identity.entitlements` is resolved server-side,
 * which means a support-issued grant is visible here exactly as the gate sees
 * it.
 */
export function heldBy(identity: MeResponse): Capability[] {
  return capabilitiesFor(identity.plan, identity.entitlements as EntitlementKey[]);
}

export function can(identity: MeResponse, capability: Capability): boolean {
  return hasCapability(capability, identity.plan, identity.entitlements as EntitlementKey[]);
}
