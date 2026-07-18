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

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "claude-opus-4-8", name: "Opus 4.8", context: "1M" },
  { id: "claude-sonnet-5", name: "Sonnet 5", context: "1M" },
  { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", context: "200K" },
];
