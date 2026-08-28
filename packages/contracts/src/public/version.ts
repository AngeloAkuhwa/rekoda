/**
 * The public API's version line (canonical spec §27).
 *
 * §27 requires public contracts to be "versioned independently of the
 * schema". This file is what independence means in practice: the list of
 * versions Rekoda serves, and the dates on which a version stops being
 * served. Neither is derived from anything in `packages/db`, and a migration
 * cannot move either.
 *
 * A version is a promise about SHAPE, not a release number. Adding an
 * optional field to a response is not a new version; removing a field,
 * renaming one, narrowing an enum or changing what a field means is. The
 * shape tests in `v1/shape.test.ts` are what stop the difference being a
 * matter of opinion.
 */

/** Every version the API answers on. Ordered oldest first. */
export const PUBLIC_API_VERSIONS = ['v1'] as const;
export type PublicApiVersion = (typeof PUBLIC_API_VERSIONS)[number];

/** What a client gets when it does not ask for a version by name. */
export const CURRENT_PUBLIC_API_VERSION: PublicApiVersion = 'v1';

export interface VersionRetirement {
  /** When the version was announced as going away. Sent as `Deprecation`. */
  deprecatedAt: string;
  /** When it stops answering. Sent as `Sunset`. Never earlier than one year. */
  sunsetAt: string;
}

/**
 * Versions on their way out, and when they go.
 *
 * Empty today, and deliberately a table rather than a code path: the day v1
 * is deprecated, an integrator learns it from the `Deprecation` and `Sunset`
 * headers on every response they already make, not from a blog post they
 * never read. A merchant's integration breaking without warning is a
 * merchant's business breaking without warning.
 */
export const PUBLIC_API_RETIREMENTS: Partial<Record<PublicApiVersion, VersionRetirement>> = {};

/** Whether a path segment names a version this API serves. */
export function isPublicApiVersion(value: string): value is PublicApiVersion {
  return (PUBLIC_API_VERSIONS as readonly string[]).includes(value);
}
