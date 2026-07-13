// The CLI's version. Injected at compile time by scripts/build-cli.ts via
// `bun build --define OCD_CLI_VERSION=...`. Under `bun run src/cli/main.ts`
// (dev) the define is absent, so `typeof` keeps the reference safe and we
// report "dev".
declare const OCD_CLI_VERSION: string | undefined;

export const VERSION: string =
  typeof OCD_CLI_VERSION !== "undefined" ? OCD_CLI_VERSION : "dev";
