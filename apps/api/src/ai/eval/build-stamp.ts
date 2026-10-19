/**
 * Which code a launch-gate run executed, proven rather than assumed (G-07,
 * Codex on #273).
 *
 * The api build ends by stamping a manifest: a hash of every source file
 * and of every compiled file across the workspace packages the runner is
 * built from. Before a gate run the runner hashes both again. A compiled
 * file edited after the build no longer matches its output hash; source
 * changed or checked out since the build no longer matches its source hash;
 * either way the run is refused rather than attributed to the clean commit.
 * Timestamps prove nothing here and are not used.
 *
 *   node dist/ai/eval/build-stamp.js     (run by the api build, after tsc)
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from '@rekoda/db';

/** Every workspace package the runner's code is built from. */
export const BUILT_PACKAGES = [
  'apps/api',
  'packages/core',
  'packages/db',
  'packages/contracts',
  'packages/shared',
] as const;

/** Where the manifest lives, relative to the repository root. */
export const MANIFEST_PATH = 'apps/api/dist/build-manifest.json';

/** The repository root, from this compiled file (apps/api/dist/ai/eval). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export interface BuildIdentity {
  /** Every source file of every built package, by path and content. */
  readonly source: string;
  /** Every compiled file that can run, by path and content. */
  readonly output: string;
}

/** A tree's files, sorted by path, hashed with their contents. */
function treeHash(
  root: string,
  dirs: readonly string[],
  keep: (relative: string) => boolean,
): string {
  const hash = createHash('sha256');
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      hash.update(`missing ${rel}\n`);
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      const relative = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path, relative);
      else if (keep(relative)) {
        hash.update(`${relative}\n`);
        hash.update(readFileSync(path));
      }
    }
  };
  for (const dir of dirs) walk(join(root, dir), dir);
  return `sha256:${hash.digest('hex')}`;
}

export function buildIdentity(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
): BuildIdentity {
  return {
    source: treeHash(
      root,
      packages.map((pkg) => `${pkg}/src`),
      () => true,
    ),
    output: treeHash(
      root,
      packages.map((pkg) => `${pkg}/dist`),
      (relative) => /\.(js|mjs|cjs|json)$/.test(relative) && !relative.endsWith(MANIFEST_PATH),
    ),
  };
}

/** Written by the build, once every package's output exists. */
export function writeBuildManifest(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
): BuildIdentity {
  const identity = buildIdentity(root, packages);
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export interface BuildVerdict {
  /** True only when both hashes match the manifest the build stamped. */
  readonly verified: boolean;
  /** Why not, when not. */
  readonly reason: string | null;
  /** The compiled code's hash, reported as the run's identity. */
  readonly output: string;
}

/**
 * The build checked against its own manifest. Anything that cannot be
 * checked (no manifest, a file that cannot be read) is unverified: a gate
 * run must not pass on what it could not prove.
 */
export function verifyBuild(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
): BuildVerdict {
  try {
    const now = buildIdentity(root, packages);
    let stamped: BuildIdentity;
    try {
      stamped = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')) as BuildIdentity;
    } catch {
      return {
        verified: false,
        reason: 'the build carries no manifest; run pnpm turbo build',
        output: now.output,
      };
    }
    if (stamped.source !== now.source) {
      return {
        verified: false,
        reason: 'the source changed after it was built; run pnpm turbo build',
        output: now.output,
      };
    }
    if (stamped.output !== now.output) {
      return {
        verified: false,
        reason: 'a compiled file changed after the build; run pnpm turbo build --force',
        output: now.output,
      };
    }
    return { verified: true, reason: null, output: now.output };
  } catch {
    return { verified: false, reason: 'the build could not be read to verify', output: 'unknown' };
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const identity = writeBuildManifest(REPO_ROOT);
  console.log(`build manifest written: output ${identity.output}`);
}
