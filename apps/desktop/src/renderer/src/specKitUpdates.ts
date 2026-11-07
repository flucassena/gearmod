import { isOutdated } from '@gearmod/contracts'

// Reviewed against v1.3.2 (6 Nov 2026) by reading the Spec Kit source and the changes since v1.2.5, not by an end-to-end run with agents. What GearMod
// relies on is unchanged: the skills at `.claude/skills/speckit-<step>/SKILL.md` and `.agents/skills/speckit-<step>/SKILL.md`, and `.specify/feature.json`
// with `SPECIFY_FEATURE_DIRECTORY` in `scripts/bash/common.sh`. The only removal is the `taskstoissues` command, which the app does not use.
export const specKitUpdateCeiling = '1.3.2'
export const specKitInstallCommand = `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v${specKitUpdateCeiling}`

export function specKitUpdateState(installed: string | null, latest: string | null): { newerAvailable: boolean; canUpdate: boolean } {
  const valid = (value: string | null): boolean => value !== null && /^\d+\.\d+\.\d+$/.test(value)
  return {
    newerAvailable: valid(latest) && isOutdated(specKitUpdateCeiling, latest),
    canUpdate: valid(installed) && valid(latest) && isOutdated(installed, latest) && isOutdated(installed, specKitUpdateCeiling)
  }
}
