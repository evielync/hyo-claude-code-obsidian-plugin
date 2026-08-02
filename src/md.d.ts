// CHANGELOG.md is inlined as a string by esbuild's text loader.
declare module "*.md" {
  const content: string;
  export default content;
}
