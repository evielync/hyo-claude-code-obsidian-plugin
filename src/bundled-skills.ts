import type { Skill } from "./hooks/useSkills";

/**
 * Skills that ship inside the Claude Code CLI.
 *
 * These are not files on disk. The CLI packs them into its own binary and
 * unpacks one to a temp directory the first time it's used, so the folder scan
 * in `useSkills` can never find them — which is why they've been invisible in
 * Hyo despite working perfectly well when typed.
 *
 * Listed here rather than discovered, because there's nothing to discover until
 * a skill has already been run. If the CLI drops one, typing it falls through
 * to the model as ordinary text rather than erroring — mildly untidy, not
 * damaging.
 *
 * Deliberately not the full set. The CLI also bundles code-review,
 * security-review, review, verify, simplify, run, init and
 * fewer-permission-prompts (developer tools, not what Hyo is for) and
 * claude-api, update-config and keybindings-help (configuration surfaces that
 * do more harm than good one slash away from a chat box).
 */
export const BUNDLED_SKILLS: Skill[] = [
  {
    name: "deep-research",
    description:
      "Research a question across many sources, fact-check the claims, and write it up with citations",
    content: "",
  },
  {
    name: "dataviz",
    description: "Build charts, dashboards and data visualisations that actually read well",
    content: "",
  },
  {
    name: "loop",
    description:
      "Run a prompt on a repeating interval — every 20 minutes, every hour, until you stop it",
    content: "",
  },
  {
    name: "schedule",
    description:
      "Schedule an agent to run in the cloud on a recurring basis, even when Obsidian is closed",
    content: "",
  },
];

/**
 * Merge the bundled skills into the user's own, with the user's winning.
 *
 * Someone who writes their own `/loop` should get theirs — a skill they wrote
 * and can see on disk should never be shadowed by one they can't.
 */
export function withBundledSkills(userSkills: Skill[]): Skill[] {
  const own = new Set(userSkills.map((s) => s.name));
  const bundled = BUNDLED_SKILLS.filter((s) => !own.has(s.name));
  return [...userSkills, ...bundled].sort((a, b) => a.name.localeCompare(b.name));
}
