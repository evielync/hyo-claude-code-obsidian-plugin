/**
 * Where Hyo's conversations live: Settings → Working directory, with a
 * leading ~ expanded, or the vault when it's blank. Desktop panels, the
 * gateway the phone talks to and the session owners all key off this one
 * value, so they always agree on which conversations exist.
 */
export function resolveWorkingDirectory(setting: string | undefined | null, vault: string, home?: string): string {
  const s = (setting || "").trim();
  if (!s) return vault;
  const h = home ?? (typeof process !== "undefined" ? process.env.HOME || process.env.USERPROFILE || "" : "");
  return s.replace(/^~/, h);
}
