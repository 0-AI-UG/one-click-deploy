# Validation Rules

All deploy inputs are validated before any infrastructure is created. Validation logic lives in `src/bun/validate.ts`.

## App Name

- Lowercase alphanumeric characters and hyphens only
- 3 to 63 characters
- Cannot start or end with a hyphen
- No consecutive hyphens (`--`)
- Must be unique across your servers

## Git Repository

- Must be an HTTPS URL (`https://...`) or SSH URL (`git@...`)
- No shell metacharacters allowed (prevents command injection)
- Private repos require a GitHub PAT configured in settings

## Container Port

- Integer between 1 and 65535

## Custom Domain

- Valid DNS hostname
- Each label: 1-63 characters, alphanumeric + hyphens
- Total length: max 253 characters
- Requires Hetzner DNS token and zone ID configured

## Environment Variables

- Keys must be valid identifiers: start with a letter or underscore, then alphanumeric/underscores
- Reserved prefixes that are **not allowed**:
  - `DOCKER_` — conflicts with Docker internals
  - `PATH` — system path
  - `HOME` — home directory
  - `LD_` — dynamic linker
  - `DYLD_` — macOS dynamic linker

## Hetzner API Token

- 32 to 128 characters
- Printable ASCII only

## GitHub PAT

- 30 to 256 characters
- Printable ASCII only
