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

## Using these files safely (Rekoda rules; the vendored files stay unmodified)

The vendored files are byte-identical to upstream so the hashes in
`skills-lock.json` mean something. We never patch them. A concern about
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
5. **Impeccable.** Never run `scripts/impeccable` or `scripts/impeccable.cmd`
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
6. **Taste's `scripts/assets.mjs`** (stock-image fetch) is never run on Rekoda
   work. `inspect.mjs` and `draw.mjs` start a local Chrome only when an agent
   runs them; point `inspect.mjs` only at a local or test-data build, never at
   a page holding real merchant data. The `.taste-skill/` output directory is
   git-ignored.
