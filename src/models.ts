// Single source of truth for Hyo's built-in model list. Shared by the picker
// (HyoStatusBar) and the Settings default-model dropdown so the two can never
// drift out of sync.
//
// Older generations (Opus 4.7/4.6, Sonnet 4.6) were intentionally removed to
// keep the list clean — they cost the same as the current models and are
// superseded by them. Anyone who wants a specific or older model can add it
// via the picker's "Custom model ID" field, which persists it into the user's
// own list (managed under Settings → Custom models).
export interface ModelOption {
  id: string;
  name: string;
  context: string;
}

// Context windows, verified against GET /v1/models rather than assumed.
// Keyed by ID prefix so dated variants (claude-haiku-4-5-20251001) resolve
// without needing their own entry.
//
// This is the SINGLE source of truth for context size. The picker's display
// label is computed from it below — previously the label and the gauge's limit
// were derived separately, which is how Opus 5 came to be advertised as "1M"
// in the picker while the gauge sized it at 200K.
//
// Only the models actually reachable in Hyo are listed — the four in the
// picker plus Opus 4.7, which is in use via the custom-model field. Anything
// else falls through to the default rule at the bottom of getContextLimit,
// which already handles the "[1m]" convention correctly, so listing further
// models would add names without changing behaviour.
//
// NATIVE_1M means 1M with no suffix, and the "[1m]" suffix is INVALID — the
// API silently falls back to 200K instead of erroring, so a stray suffix must
// be stripped before spawn. Older models where "[1m]" is what *unlocks* 1M are
// deliberately absent: they need the suffix kept, which the default rule does.
const NATIVE_1M = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
];

// Capped at 200K regardless of any suffix — without this a stray "[1m]" would
// inflate the gauge to 1M and hide a real limit.
const ALWAYS_200K = ["claude-haiku-4-5"];

const DEFAULT_CONTEXT = 200_000;

/** Strip the "[1m]" long-context suffix, leaving the bare model ID. */
export function baseModelId(id: string): string {
  return id.replace(/\[1m\]/g, "");
}

function matches(list: string[], base: string): boolean {
  return list.some((prefix) => base.startsWith(prefix));
}

/** True when the model runs 1M natively and REJECTS the "[1m]" suffix. */
export function isNative1M(modelId: string): boolean {
  return matches(NATIVE_1M, baseModelId(modelId));
}

/**
 * Actual usable context window for a model ID, in tokens.
 *
 * Unknown IDs (anything added via the picker's custom field) fall back to the
 * conservative 200K unless they carry an explicit "[1m]" suffix — better to
 * under-promise than to size the gauge at 1M and let the user sail past a real
 * limit without warning.
 */
export function getContextLimit(modelId: string): number {
  const base = baseModelId(modelId);
  const hasSuffix = modelId.includes("[1m]");

  if (matches(ALWAYS_200K, base)) return 200_000;
  if (matches(NATIVE_1M, base)) return 1_000_000;
  // Everything else — older models and custom IDs alike — reaches 1M only when
  // the "[1m]" suffix is explicitly present.
  return hasSuffix ? 1_000_000 : DEFAULT_CONTEXT;
}

function formatContext(tokens: number): string {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 1_000_000)}M`
    : `${Math.round(tokens / 1000)}K`;
}

function model(id: string, name: string): ModelOption {
  return { id, name, context: formatContext(getContextLimit(id)) };
}

export const MODEL_OPTIONS: ModelOption[] = [
  model("claude-fable-5", "Fable 5"),
  model("claude-opus-5", "Opus 5"),
  model("claude-opus-4-8", "Opus 4.8"),
  model("claude-sonnet-5", "Sonnet 5"),
  model("claude-haiku-4-5-20251001", "Haiku 4.5"),
];

// Reasoning effort — how hard the model works before answering. Paired with
// the model in the picker, the way Claude's own model menu does it.
//
// The CLI has no flag for this; it reads CLAUDE_CODE_EFFORT_LEVEL off the
// process environment, which is why it's applied in claude-transport rather
// than as an argv entry. Values are validated by the CLI against exactly this
// list — anything else is silently ignored and falls back to the default,
// so the picker must never offer a value outside it.
export interface EffortOption {
  id: string;
  name: string;
  desc: string;
}

export const DEFAULT_EFFORT = "medium";

export const EFFORT_OPTIONS: EffortOption[] = [
  { id: "low", name: "Low", desc: "Fastest — for short, simple tasks" },
  { id: "medium", name: "Medium", desc: "Balanced for everyday work" },
  { id: "high", name: "High", desc: "More thorough — intelligence-sensitive work" },
  { id: "max", name: "Max", desc: "Most thorough, slowest, burns limits fastest" },
];
