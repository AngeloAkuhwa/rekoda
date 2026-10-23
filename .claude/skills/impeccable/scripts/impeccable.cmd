@echo off
rem REKODA PATCH (not upstream): disabled launcher. See .claude/skills/SOURCES.md,
rem "Patches to vendored files". Never downloads or executes a binary; always fails.
echo impeccable: launcher disabled in this repository (no downloaded or third-party binaries are executed). 1>&2
echo Take the skill's 'Launcher unavailable' path; see .claude/skills/SOURCES.md, rule 5. 1>&2
exit /b 126
