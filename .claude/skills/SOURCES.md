# Vendored design skills: provenance

These directories are third-party agent skills committed so a fresh clone (the
hourly MVP Autopilot routine included) has them without a network install.
They support UI work; they never override `docs/REKODA_DESIGN_SYSTEM.md`,
`design-system/rekoda/MASTER.md`, the canonical spec or the owner rulings.
Selection policy: `CLAUDE.md` §7c and the playbook's "Design skill selection
and visual QA".

| Skill directory(ies)                                                                                                                 | Upstream                                                                | Pinned at                                         | Installed by                                                                                 | Licence    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| `emil-design-eng`, `animate`, `animation-performance`, `animation-vocabulary`, `review-animations`, `improve-animations`, `break-ui` | https://github.com/emilkowalski/skills (commit `2d22863`, 11 Oct 2026)  | `skills-lock.json` (per-skill `computedHash`)     | `npx skills@1.7.4 add emilkowalski/skills --agent claude-code --copy` (selected skills only) | MIT        |
| `design-taste-frontend`                                                                                                              | https://github.com/Leonxlnx/taste-skill (commit `6010f91`, 20 Oct 2026) | `skills-lock.json` (`computedHash`)               | `npx skills@1.7.4 add Leonxlnx/taste-skill --agent claude-code --copy`                       | MIT        |
| `impeccable`                                                                                                                         | https://github.com/pbakaus/impeccable (commit `69c34b7`, v4.7.0)        | commit `69c34b7c3d6267dfd783dacb9f58f04522656b2b` | **Copied by hand** from `plugin/skills/impeccable` at that commit (see below)                | Apache-2.0 |

Licence texts: `_licenses/`.

## Deviations and exclusions (read before updating)

- **Impeccable was not installed with `npx impeccable install`.** That
  installer downloads a signed skill bundle from `impeccable.style`, which the
  cloud sandbox's network policy blocks (it failed closed; nothing was
  written). The skill files here are the upstream compiled plugin build at the
  pinned commit. To replace them with the signed bundle, run
  `npx impeccable install --project --no-hooks` from a machine that can reach
  `impeccable.style`, and review the diff.
- **No hooks.** Impeccable ships Claude Code hooks (SessionStart, PostToolUse on
  every Edit/Write, and a Stop "design deep pass") that run a downloaded
  binary. They are deliberately not installed: they would change the
  autopilot's behaviour on every edit. Do not add them without an owner ruling.
- **Impeccable's engine binary is not vendored, and its launcher is never run.**
  `scripts/impeccable` would fetch a platform binary from GitHub Releases and
  execute it. Its checksum file comes from the same release URL, so the check
  catches a corrupted download but does not prove origin. Rekoda always takes
  the skill's documented "Launcher unavailable" path instead (rule 5).
- **Emil Kowalski skills not installed:** `write-swift`, `apple-design`,
  `animate-expo` and `mobile-native` (native-app oriented),
  `pick-ui-library`, `prototype`, `ask-sonner` (Rekoda uses no Sonner and no
  animation library). Re-add one only when a task needs it.
- **`design-taste-frontend/scripts/assets.mjs`** fetches stock images from
  public archives. Never run it on a Rekoda task: it is for marketing imagery
  and must not see merchant data.
- `ui-ux-pro-max` is an account-level skill and is untouched.

## Verifying integrity

`skills-lock.json` holds the hash the `skills` installer computes for each
skill folder: SHA-256 over every file, sorted by relative path with
`localeCompare`, feeding each path then its bytes (`computeSkillFolderHash` in
`skills@1.7.4`). Reproduced on 22 Oct 2026 with that exact algorithm: all eight
`skills-lock.json` entries match the committed folders, and each folder equals
its pinned upstream folder byte for byte (`diff -r`). Impeccable, which the
installer did not write, hashes to
`fb28833d2d55b7de536436e9e6f2b56138ad713598092249272e503f2aa54fb6` by the same
algorithm, identical to `plugin/skills/impeccable` at `69c34b7`. Re-run that
comparison before accepting any change to a vendored file; never replace a lock
value with one that cannot be reproduced. CI runs the comparison as
`scripts/check-vendored-skills.mjs` (`pnpm skills:check`), which also fails if
any ignore rule matches a path under `.claude/skills`; an Impeccable update
changes `IMPECCABLE_HASH` there and this paragraph together.

## Updating

Re-run the installer commands above (they rewrite `skills-lock.json`), diff the
result, and re-review it as a dependency change. Impeccable was copied by hand:
update it the same way (copy the pinned upstream folder, run the integrity
check above, review the diff). Do not auto-update.

## Patches to vendored files (security hardening, 23 Oct 2026)

Owner security direction: no design skill may expose the repository through an
unrestricted local web server, and no skill may download or run a third-party
binary unattended. Written rules were not enough, so two skills carry the
smallest technical patches that enforce this. They are the **only** deviations
from upstream. `skills-lock.json` keeps the upstream `computedHash` for each skill
(Impeccable: `IMPECCABLE_HASH` in the guard) and records the deviation under
`rekodaPatches`: the upstream folder hash, the patched folder hash and, per file,
the upstream and patched SHA-256. `scripts/check-vendored-skills.mjs` accepts a
patched skill only when the folder matches the patched hash, every patched file
matches its recorded hash, each recorded file hash (first 8 hex characters) appears
in the table below, and the patch was made from the recorded upstream. An edit to a
listed file without updating the lock fails, as does any edit elsewhere in a vendored
skill. The lock is self-declared: an edit to an unlisted file passes only when the
same change also adds it to `rekodaPatches` and documents it here, so review of
`skills-lock.json` and this file is part of reviewing any such change. Tests: `scripts/check-vendored-skills.test.mjs` (guard)
and `scripts/vendored-skills-hardening.test.mjs` (behaviour).

| File                                                      | Upstream      | Patched       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design-taste-frontend/scripts/inspect.mjs`               | `9482c546...` | `c3bc98ce...` | Local-file server replaced by a call to `serveLocalFile()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `design-taste-frontend/scripts/scenes.mjs`                | `234ec582...` | `99675289...` | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `design-taste-frontend/scripts/lib/rekoda-safe-serve.mjs` | (added)       | `777bcf00...` | The only server these scripts may start: serves `dirname(target)` only; refuses a root without an explicit `.taste-serve-root` marker, a root not below `os.tmpdir()`, `/`, a root containing `$HOME`, a root inside any git work tree (`.git` at or above it), a root containing the cwd's work tree, and a root with a `.git` entry anywhere below it (bounded walk, 6 levels and 5,000 entries, failing closed at the bound or on an unreadable directory); refuses `..`, encoded traversal, symlinks leaving the root, any dot-segment (so `.env`, `.git` and the marker), non-GET/HEAD and a foreign `Host`; binds `127.0.0.1`. Refusal exits 2 before any browser starts. |
| `impeccable/scripts/impeccable`                           | `f5d9fcd3...` | `e82ff32e...` | Launcher replaced by a stub that prints an explanation and exits 126. No download, no `IMPECCABLE_BIN`/home-cache/PATH execution.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `impeccable/scripts/impeccable.cmd`                       | `e0dcc4cd...` | `0af14b3d...` | Same, for Windows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Patched folder hashes (same algorithm as above): `design-taste-frontend`
`aaf91d1ee505e460edf2ee99877c37261fcf642db91e916569917f5eed39cdcf` (upstream
`69021ac7e671c0c0d85d65b570003cef360b1c296323fa28c042884e146478ca`); `impeccable`
`05b4ee6613fb2b7942919ebc41837b73c1c998ae9a9a6f6e6dcb793c63a18457` (upstream
`fb28833d2d55b7de536436e9e6f2b56138ad713598092249272e503f2aa54fb6`).

Consequences: Impeccable's `SKILL.md` Setup step 1 still names the launcher, but
running it now only fails, which triggers the skill's own "Launcher unavailable"
path. Its `live`/`generate`/detector features are therefore unavailable. To
inspect a page with Taste, copy only the built page and its assets into a fresh
directory of its own under the system temporary directory (`os.tmpdir()`, for
example from `mktemp -d`), outside any git work tree, create an empty
`.taste-serve-root` file in it on purpose, and run the script against that file. When updating from upstream,
re-apply these patches (or drop the ones upstream has fixed), then regenerate
`rekodaPatches`.

## Using these files safely (Rekoda rules)

Apart from the patches above, the vendored files are byte-identical to upstream
so the hashes in `skills-lock.json` mean something. A concern about
upstream wording (animation advice, tables, examples) is recorded as an
upstream matter and is not fixed here; concerns about how Rekoda uses them are
settled by these rules, which win over any vendored text:

1. **Sample data only.** Taste's sample details (room names, rates, pricing
   blueprints, "sum the rounded amounts on screen", pound examples, two-decimal
   money) are rules for layout mock-ups. A real Rekoda screen renders values
   computed by `@rekoda/core` from integer kobo, shown in naira. A skill never
   supplies Rekoda pricing, plan limits, VAT, tax or e-invoicing copy; those come
   from the canonical documents and owner rulings (OWN-30).
2. **Rekoda's design system outranks the inspector.** If `inspect.mjs` fails a
   device that `docs/REKODA_DESIGN_SYSTEM.md` or
   `design-system/rekoda/MASTER.md` approves, the design system wins. Pass
   `--allow <rule>` only for that case and name the rule and the reason in the PR.
3. **No animation library.** Rekoda has no `framer-motion` or `motion` dependency.
   Examples that import one are illustrative; implement with CSS or the Web
   Animations API unless the owner approves a library.
4. **Asset templates are not product code.** `assets/*.js` and `assets/scenes/*`
   (charts, stage) build markup with `innerHTML`. Never copy them into
   `apps/web`. If one is ever reused, escape every dynamic string first.
5. **Impeccable.** The launcher is disabled by a patch (it only exits 126), and
   you still never run `scripts/impeccable` or `scripts/impeccable.cmd`
   with any verb (`context`, `hooks`, `pin`, `doctor`, `detect` or any other),
   even though the skill's Setup step 1 says to: running it is what downloads
   and executes the engine binary. Take the skill's "Launcher unavailable" path
   every time: say that context loading did not run, then read
   `docs/REKODA_DESIGN_SYSTEM.md` and `design-system/rekoda/MASTER.md` directly.
   Where a reference playbook calls the launcher (for example the detector in
   `reference/audit.md` and `reference/critique.md`), skip that step and say
   in the report that the detector or rendered scan did not run. Do not run
   its `init`, `document` or `extract` commands: they write `PRODUCT.md`,
   `DESIGN.md` and `.impeccable/` files that would compete with Rekoda's
   design documents, and `document` may describe components the code does not
   implement. Hooks stay off, and no binary is installed under `~/.impeccable`.
   Its `live` and `generate` modes run through the launcher and are therefore
   unavailable; nothing from `scripts/live-browser*.js` is ever injected into a
   page that holds real merchant data.
6. **Taste's `scripts/assets.mjs`** (stock-image fetch) is never run on Rekoda
   work. `inspect.mjs` and `draw.mjs` start a local Chrome only when an agent
   runs them; point `inspect.mjs` only at a local or test-data build, never at
   a page holding real merchant data. For a local file, `inspect.mjs` and
   `scenes.mjs` now serve only the file's own directory, and only when it holds
   a deliberate `.taste-serve-root` marker, lies below `os.tmpdir()`, is not
   inside a git work tree and holds no repository below it (patch above,
   enforced in code and tested). The page's scripts can still read everything
   served: copy the built page and only its assets into a fresh temporary
   directory of its own, never anywhere that
   holds `.env` files, `.git/` or credentials. The `.taste-skill/` output
   directory is git-ignored. Known limits of the guard, which this rule
   covers: the root is checked once, when the server starts, so nothing may be
   copied or cloned into it while the script runs; a hard link into the
   repository cannot be detected, so never hard-link files into the root (copy
   them); and on Windows the checks were reviewed but not run, and a short
   (8.3) path name can differ from the long name, which makes the guard refuse
   rather than serve.
