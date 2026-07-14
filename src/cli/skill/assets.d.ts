// The skill assets are imported as raw text (`with { type: "text" }`) and
// inlined by `bun build --compile`. Declare them as string modules so tsc
// resolves the imports. Patterns are specific enough not to affect ordinary
// `.json` imports (e.g. package.json).
declare module "*.md" {
  const content: string;
  export default content;
}
declare module "*.jsonc" {
  const content: string;
  export default content;
}
