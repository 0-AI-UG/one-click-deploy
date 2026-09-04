# Contributing to Open CLI Deployment

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) (latest)
- Docker (for building/testing the container image)

### Getting Started

```bash
# Clone the repo
git clone https://github.com/0-AI-UG/open-cli-deployment.git
cd open-cli-deployment

# Install dependencies
bun install

# Start development
bun run dev
```

### Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Start the panel on :3001 with hot reload and `SKIP_2FA=1` |
| `bun run start` | Start the panel in production mode |
| `bun run build` | Build the web bundle into `src/web/dist` |
| `bun run typecheck` | Run TypeScript type checking |
| `bun test` | Run backend tests |

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

Use [GitHub Issues](https://github.com/0-AI-UG/open-cli-deployment/issues) to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Your browser and panel version

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
