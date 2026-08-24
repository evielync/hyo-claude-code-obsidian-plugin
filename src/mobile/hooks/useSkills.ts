// Desktop scanned .claude/skills directories via fs to power the "/" slash
// menu. There's no fs on mobile and no gateway RPC for listing skills, so
// this is stubbed to return no skills — the slash menu still works for the
// built-in commands (/compact, /context) defined directly in ChatPanel.

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export function useSkills(_workingDirectory: string): Skill[] {
  return [];
}
