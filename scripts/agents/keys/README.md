# Reviewer / contract-authority public keys

The committed Ed25519 PUBLIC verification keys of the control plane's
signing authorities (docs/AUTONOMOUS-ENGINEERING.md §6). The evaluator
accepts a Claude/Gemini verdict or a workflow-posted contract marker
ONLY when its SIGNATURE verifies against the matching key here:

- `claude-reviewer.pub.pem` — verifies `REKODA_CLAUDE_APPROVAL`
- `gemini-reviewer.pub.pem` — verifies `REKODA_GEMINI_APPROVAL`
- `contract-authority.pub.pem` — verifies `REKODA_CONTRACT_BASELINE` /
  `REKODA_CONTRACT_REVISION` (owner-authored markers need no signature)

**No keys are committed yet — the gates fail closed until they are.**
The owner generates them locally with
`node scripts/agents/generate-signing-keys.mjs`, commits the three
`.pub.pem` files, and pastes each printed PRIVATE key into its own
GitHub environment secret (`agents-claude-reviewer` /
`agents-gemini-reviewer` / `agents-contract-authority`). Private keys
never enter this repository in any form.
