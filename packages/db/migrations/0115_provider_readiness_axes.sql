-- Provider readiness as independent axes (PR-119, owner ruling 28 Aug 2026).
--
-- 0093 gave the platform's standing ONE blended status per provider and
-- port, AVAILABLE or BLOCKED, with a sentence explaining which. That is the
-- same mistake §17.1 named for connections, one level up: a blended status
-- makes a real state unrepresentable. "The adapter is written and passes
-- its tests, the commercial terms are signed, and legal has not finished"
-- is a sentence the old column could only render as BLOCKED with a note,
-- so nobody could see which of the three was outstanding, or that two of
-- them were already done.
--
-- Three axes, because they fail independently and are cleared by different
-- people on different timescales:
--
--   technical_support    Rekoda has an adapter for this port and it passes
--                        its tests against the provider's own sandbox.
--   commercial_approval  there is a signed production arrangement.
--   compliance_approval  it is permitted under Rekoda's own policy and the
--                        applicable regulation.
--
-- And one derived: production_enabled, GENERATED from all three, so
-- "derived" is a property of the schema rather than a habit of whoever
-- writes the next UPDATE. This is the structural form of the owner's
-- instruction that a working sandbox must never open production: passing
-- tests sets exactly one axis, and one axis is never enough.
--
-- Every axis DEFAULTS FALSE. A provider added tomorrow is closed until
-- three separate people say otherwise, which is the safe direction.

ALTER TABLE provider_capabilities
  ADD COLUMN technical_support   boolean NOT NULL DEFAULT false,
  ADD COLUMN technical_note      text,
  ADD COLUMN commercial_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN commercial_note     text,
  ADD COLUMN compliance_approval boolean NOT NULL DEFAULT false,
  ADD COLUMN compliance_note     text;

/* A closed axis must say who or what is holding it, exactly as 0093's
 * BLOCKED had to carry a reason. An unexplained "no" is a state nobody can
 * act on and nobody can date. */
ALTER TABLE provider_capabilities
  ADD CONSTRAINT provider_capabilities_axes_reasoned CHECK (
    (technical_support   OR technical_note   IS NOT NULL) AND
    (commercial_approval OR commercial_note  IS NOT NULL) AND
    (compliance_approval OR compliance_note  IS NOT NULL)
  ) NOT VALID;

/* Today's standing, carried forward rather than re-decided. Paystack
 * COLLECT was AVAILABLE in 0093 because the estate already transacts on
 * it; that is a recorded decision, not an assumption, so all three of its
 * axes are true. Everything else keeps the blocker 0093 named, on the axis
 * that blocker actually belongs to - which is the point of the split.
 *
 * Kuda is the case that proves it. 0093 gave it one BLOCKED with a
 * compliance sentence; it is really TWO closed axes, compliance AND
 * commercial, and the adapter (PR-071) is written and tested. A single
 * status could not say that, and "we only need the commercial one" is
 * exactly the misreading it invited. */
UPDATE provider_capabilities SET
  technical_support   = true,
  technical_note      = NULL,
  commercial_approval = true,
  commercial_note     = NULL,
  compliance_approval = true,
  compliance_note     = NULL
WHERE provider_type = 'paystack' AND capability = 'COLLECT';

UPDATE provider_capabilities SET
  technical_support   = true,
  technical_note      = NULL,
  commercial_approval = false,
  commercial_note     = 'OPEN COMMERCIAL: Mono production terms (build plan, external blockers)',
  compliance_approval = true,
  compliance_note     = NULL
WHERE provider_type = 'mono';

UPDATE provider_capabilities SET
  technical_support   = true,
  technical_note      = NULL,
  commercial_approval = false,
  commercial_note     = 'OPEN COMMERCIAL: OPay production access (build plan, external blockers)',
  compliance_approval = true,
  compliance_note     = NULL
WHERE provider_type = 'opay';

UPDATE provider_capabilities SET
  technical_support   = true,
  technical_note      = NULL,
  commercial_approval = false,
  commercial_note     = 'OPEN COMMERCIAL: Kuda production commercial terms (build plan, external blockers)',
  compliance_approval = false,
  compliance_note     = 'OPEN COMPLIANCE: Kuda regulatory approval, owner ruling 28 Aug 2026'
WHERE provider_type = 'kuda';

/* Any row an operator added between 0093 and here keeps its meaning: an
 * AVAILABLE row opens all three, a BLOCKED row closes commercial and keeps
 * its sentence, which is the reading that refuses rather than permits. */
UPDATE provider_capabilities SET
  technical_support   = (status = 'AVAILABLE'),
  technical_note      = CASE WHEN status = 'AVAILABLE' THEN NULL ELSE 'migrated from 0093 status' END,
  commercial_approval = (status = 'AVAILABLE'),
  commercial_note     = CASE WHEN status = 'AVAILABLE' THEN NULL ELSE coalesce(reason, 'migrated from 0093 status') END,
  compliance_approval = (status = 'AVAILABLE'),
  compliance_note     = CASE WHEN status = 'AVAILABLE' THEN NULL ELSE coalesce(reason, 'migrated from 0093 status') END
WHERE provider_type NOT IN ('paystack', 'mono', 'opay', 'kuda');

ALTER TABLE provider_capabilities VALIDATE CONSTRAINT provider_capabilities_axes_reasoned;

/* Derived, and derived in the SCHEMA. A boolean somebody has to remember to
 * recompute is a boolean that will one day disagree with its inputs, and
 * this particular one decides whether real money moves. */
ALTER TABLE provider_capabilities
  ADD COLUMN production_enabled boolean
    GENERATED ALWAYS AS (technical_support AND commercial_approval AND compliance_approval) STORED;

/* `status` and `reason` are gone rather than kept in step. Two sources of
 * truth for "may this provider be used" is the defect, not the fix, and
 * this table is small global reference data with no history to preserve. */
ALTER TABLE provider_capabilities DROP CONSTRAINT provider_capabilities_reasoned;
ALTER TABLE provider_capabilities DROP COLUMN status;
ALTER TABLE provider_capabilities DROP COLUMN reason;

COMMENT ON COLUMN provider_capabilities.technical_support IS
  'Rekoda has an adapter for this port and it passes its tests against the '
  'provider sandbox. Never sufficient on its own: a working sandbox does '
  'not open production (owner ruling, 28 Aug 2026).';
COMMENT ON COLUMN provider_capabilities.production_enabled IS
  'Derived by the database from all three axes. Not writable.';
