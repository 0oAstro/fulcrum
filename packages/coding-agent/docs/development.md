# Development

See the repository [AGENTS.md](../../../AGENTS.md) for the current contribution rules and required validation.

## Setup

Fulcrum requires Node.js 22.8.0 or newer.

```bash
cd /path/to/fulcrum
npm ci
```

Run from source:

```bash
/path/to/fulcrum/fulcrum.sh
```

The script can be called from any directory and preserves the caller's working directory. Use that behavior to run a source checkout against a separate test project.

## Product and Source Names

Fulcrum is the product, public CLI, release artifact, and repository name. The monorepo still retains inherited `@earendil-works/pi-*` npm workspace names, a source-package `pi` bin entry, the `pi` package manifest key, and some `PI_*` compatibility environment variables. These names are source and compatibility details, not a signal that contributors should install or develop against pi-mono.

Public releases are currently versioned tarball artifacts installed by the stable and beta installer scripts. `scripts/pack-fulcrum-release.mjs` rewrites the coding-agent package name, executable, config metadata, and internal dependency URLs for that distribution. Do not document the inherited npm workspace package as the public Fulcrum install path.

## Local Configuration

User configuration lives under `~/.fulcrum/`. Project-local settings, prompts, themes, extensions, skills, and system-prompt files live under `.fulcrum/` in the project root. Override the user config directory with `FULCRUM_CODING_AGENT_DIR` and the session directory with `FULCRUM_SESSION_DIR`.

Use an isolated config directory when manually exercising daemon behavior so development sessions do not collide with normal sessions:

```bash
FULCRUM_CODING_AGENT_DIR=/tmp/fulcrum-dev /path/to/fulcrum/fulcrum.sh
```

## Daemon Protocol Changes

Classify every daemon command, event, or response-shape change as backward-compatible, capability-gated, or incompatible. Optional behavior must be negotiated and degrade locally. Follow the protocol-version, schema-revision, compatibility-map, and cross-version test requirements in the root `AGENTS.md` before changing the wire contract.

## Package Asset Resolution

Fulcrum runs from source, Node.js package output, and standalone release artifacts. Always use `src/config.ts` helpers for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Do not resolve packaged assets directly from `__dirname`.

## Debugging

The hidden `/debug` command writes `~/.fulcrum/fulcrum-debug.log` with rendered TUI lines, their visible widths, and the current agent messages. Daemon, worker, client, and provider diagnostic logs live under `~/.fulcrum/logs/`.

Useful service commands:

```bash
fulcrum status
fulcrum doctor
fulcrum doctor --fix
fulcrum shutdown
```

## Validation

After code changes, run the repository check from the root:

```bash
npm run check
```

This performs formatting, linting, type checking, installer rendering checks, and the browser smoke check. It does not run the test suite.

Run focused tests from the package root. For example:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

If you create or modify a test file, run that file and iterate until it passes. Coding-agent suite regressions belong under `test/suite/regressions/` and use the suite harness and faux provider rather than live provider credentials.
