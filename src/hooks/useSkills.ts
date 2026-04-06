import { useEffect, useState } from "react";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface Skill {
  name: string;
  description: string;
  content: string;
}

function parseFrontmatter(text: string): { name: string; description: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: "", description: "" };
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : "",
    description: descMatch ? descMatch[1].trim() : "",
  };
}

export function useSkills(workingDirectory: string): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);

  useEffect(() => {
    if (!workingDirectory) return;

    try {
      const resolved = workingDirectory.replace(/^~/, os.homedir());

      // Check all standard locations (same as Claude Code)
      const paths = [
        path.join(os.homedir(), '.claude', 'skills'), // User-global
        path.join(resolved, '.claude', 'skills'),      // Project .claude/skills
        path.join(resolved, 'skills'),                 // Project skills/
      ];

      const loaded: Skill[] = [];

      for (const skillsPath of paths) {
        if (!fs.existsSync(skillsPath)) continue;

        const dirs = fs
          .readdirSync(skillsPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const dir of dirs) {
          const skillFile = path.join(skillsPath, dir, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          const content = fs.readFileSync(skillFile, "utf8");
          const { name, description } = parseFrontmatter(content);

          // Avoid duplicates if same skill exists in both locations
          if (!loaded.find(s => s.name === (name || dir))) {
            loaded.push({ name: name || dir, description, content });
          }
        }
      }

      loaded.sort((a, b) => a.name.localeCompare(b.name));
      setSkills(loaded);
    } catch (e) {
      console.warn("[hyo] Failed to load skills:", e);
    }
  }, [workingDirectory]);

  return skills;
}
