// Minimal stand-in for the parts of `obsidian` that pure-ish modules touch.
export const Platform = { isDesktop: false, isMobile: false };
export class Notice {
  constructor(_m: string, _t?: number) {}
}
export class Component {
  load() {}
  unload() {}
}
export const MarkdownRenderer = { render: async () => {}, renderMarkdown: async () => {} };
export function setIcon() {}
export class Modal {}

// Network calls aren't made in tests; anything that reaches one fails loudly.
export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl isn't available in tests");
}
