# Contributing to One-Click Deploy

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) (latest)
- [Electrobun](https://electrobun.dev) v1.16+
- Node.js 20+ (for some tooling)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/0-AI-UG/one-click-deploy.git
cd one-click-deploy

# Install dependencies
bun install

# Start development
bun run dev
```

### Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start dev server |
| `bun run build` | Build the application |
| `bun run typecheck` | Run TypeScript type checking |

## Making Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Run type checking: `bun run typecheck`
5. Commit your changes with a descriptive message
6. Push to your fork and open a Pull Request

## Pull Request Guidelines

- Keep PRs focused on a single change
- Ensure type checking passes
- Describe what your PR does and why in the description
- Link any related issues

## Reporting Issues

Use [GitHub Issues](https://github.com/0-AI-UG/one-click-deploy/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Your OS and app version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
