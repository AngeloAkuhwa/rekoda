/**
 * Which code a launch-gate run executed, proven rather than assumed (G-07,
 * Codex on #273).
 *
 * `pnpm eval:build` force-builds every package the runner is built from,
 * from the source as it is, and only then stamps a manifest: a hash of that
 * source (with each package's build configuration and the lockfile) and of
 * every compiled file. Stamping after a partial build cannot happen, because
 * nothing but that script stamps (Codex on #273). Before a gate run the runner hashes both again. A compiled
 * file edited after the build no longer matches its output hash; source
 * changed or checked out since the build no longer matches its source hash;
 * either way the run is refused rather than attributed to the clean commit.
 * Timestamps prove nothing here and are not used.
 *
 *   pnpm eval:build                      (force-builds, then stamps)
 */
import { execFileSync } from 'node:child_process';
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

/**
 * What else decides the compiled code: each package's manifest and build
 * configuration, and the workspace's (final sanity review on #273).
 */
function configHash(root: string, packages: readonly string[]): string {
  const hash = createHash('sha256');
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.base.json',
    'turbo.json',
    ...packages.flatMap((pkg) => [
      `${pkg}/package.json`,
      `${pkg}/tsconfig.json`,
      `${pkg}/tsconfig.build.json`,
    ]),
  ];
  for (const file of files) {
    hash.update(`${file}\n`);
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      hash.update('absent\n');
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export function buildIdentity(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
): BuildIdentity {
  return {
    source: `${treeHash(
      root,
      packages.map((pkg) => `${pkg}/src`),
      () => true,
    )}+${configHash(root, packages)}`,
    output: treeHash(
      root,
      packages.map((pkg) => `${pkg}/dist`),
      (relative) => /\.(js|mjs|cjs|json)$/.test(relative) && !relative.endsWith(MANIFEST_PATH),
    ),
  };
}

export interface BuildManifest extends BuildIdentity {
  /**
   * The commit the stamped source is: git HEAD of a clean checkout, or the
   * REKODA_COMMIT the build was given outside git; null when neither names
   * it (a dirty checkout names nothing). A run outside git must name this
   * same commit (Codex on #273).
   */
  readonly commit: string | null;
}

/** The commit a build of `root` can be attributed to, or null. */
export function stampedCommit(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const git = { encoding: 'utf8', cwd: root, stdio: 'pipe' } as const;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], git).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], git).trim().length > 0;
    return dirty ? null : sha;
  } catch {
    const given = env.REKODA_COMMIT?.trim();
    return given ? given : null;
  }
}

/** Written by the build, once every package's output exists. */
export function writeBuildManifest(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
  commit: string | null = stampedCommit(root),
): BuildManifest {
  const manifest = { ...buildIdentity(root, packages), commit };
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export interface BuildVerdict {
  /** True only when both hashes match the manifest the build stamped. */
  readonly verified: boolean;
  /** Why not, when not. */
  readonly reason: string | null;
  /** The compiled code's hash, reported as the run's identity. */
  readonly output: string;
  /** The commit the build stamped, when it was verified and named one. */
  readonly commit?: string | null;
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
    let stamped: BuildManifest;
    try {
      stamped = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8')) as BuildManifest;
    } catch {
      return {
        verified: false,
        reason: 'the build carries no manifest; run pnpm eval:build',
        output: now.output,
      };
    }
    if (stamped.source !== now.source) {
      return {
        verified: false,
        reason: 'the source changed after it was built; run pnpm eval:build',
        output: now.output,
      };
    }
    if (stamped.output !== now.output) {
      return {
        verified: false,
        reason: 'a compiled file changed after the build; run pnpm eval:build',
        output: now.output,
      };
    }
    return { verified: true, reason: null, output: now.output, commit: stamped.commit ?? null };
  } catch {
    return { verified: false, reason: 'the build could not be read to verify', output: 'unknown' };
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const identity = writeBuildManifest(REPO_ROOT);
  console.log(`build manifest written: output ${identity.output}`);
}
