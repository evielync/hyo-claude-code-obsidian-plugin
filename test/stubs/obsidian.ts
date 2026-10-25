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
