# ByteRover memory

Fulcrum can use [ByteRover V4](https://docs.byterover.dev/v4/overview) as an optional project-memory layer through ByteRover's official Agent Skill. It is not bundled, enabled, downloaded, or contacted by default.

ByteRover complements Fulcrum's continual harness rather than replacing it:

- The continual harness stores Fulcrum prompt notes, preferences, skills, subagent specs, and session or user memory.
- ByteRover stores project decisions, conventions, runbooks, and gotchas in a project or team space.
- Fulcrum does not copy or synchronize entries between the two stores.

## Install

Review the [official skill repository](https://github.com/campfirein/skills/tree/main/skills/byterover) before installing it. Third-party skills and their scripts run with your user permissions.

Install the repository as a normal Fulcrum package:

```bash
fulcrum package install git:github.com/campfirein/skills
```

Use `--local` to install it only for the current project:

```bash
fulcrum package install git:github.com/campfirein/skills --local
```

Restart Fulcrum after installation. Fulcrum discovers `skills/byterover/SKILL.md` through the package's standard `skills/` directory and keeps its runtime scripts at the relative paths expected by the skill. When that skill is enabled, Fulcrum installs and pre-imports a thin `byterover` Python facade in persistent IPython. The facade does not vendor ByteRover's engine; it invokes the enabled skill's official Node scripts with argv-based subprocesses from the current project directory.

Use the module directly:

```python
memory = await byterover.query("authentication decisions", limit=5)
topic = await byterover.read("architecture/auth.html")
result = await byterover.record(
    "testing/unit_strategy",
    title="Unit testing strategy",
    summary="Fast in-memory service tests",
    keywords=["testing", "unit", "fixtures"],
    body="Unit tests run in memory unless explicitly marked as integration tests.",
)
```

The facade also exposes `current_space()`, `list_spaces()`, `bind_space()`, and `sync_status()`. It intentionally does not expose login, logout, or authentication helpers because Fulcrum targets the local V4 data runtime. It returns each script's JSON object and preserves successful warnings on IPython's stderr. In simple `record()` calls, `summary` and `keywords` are optional; replacing an existing topic requires `overwrite=True`, and you should read and merge the current durable facts first. Inspect `help(byterover)` and individual functions for their call contracts. Disabling or removing the ByteRover skill stops Fulcrum from advertising or pre-importing the facade on the next reload.

ByteRover V4 requires Node.js 20 or newer. It uses ByteRover Desktop to create or select spaces. Follow ByteRover's [V4 setup guide](https://docs.byterover.dev/v4/getting-started) for its supported onboarding flow.

## Local-only V4 runtime

The official V4 skill performs query and record operations locally with a deterministic, zero-LLM engine. To point Fulcrum at an initialized local V4 data root, configure:

```json
{
  "byterover": {
    "dataDir": "~/.fulcrum/byterover-v4",
    "offline": true
  }
}
```

`dataDir` is passed to the official runtime as `BRV_DATA_DIR`; relative paths resolve from Fulcrum's agent directory. On Linux, `offline: true` runs the runtime through Bubblewrap with a private network namespace. It fails closed when `bwrap` is unavailable or the same data root already has a daemon with network access, rather than allowing hosted sync or anonymous telemetry. Restart Fulcrum after changing either setting because kernel environment variables are fixed when the kernel starts.

The public V4 runtime can query and record offline once a local space exists, but ByteRover does not publish a supported headless space-creation command. Its documented flow provisions spaces through ByteRover Desktop. ByteRover also does not publish the V4 accounts, teams, or synchronization backend as source, an image, or a deployment manifest; the advertised full on-premises backend is an Enterprise offering. This integration therefore self-hosts the local V4 context engine and data, not ByteRover's private collaboration control plane.

V4 does not use an LLM provider. Azure OpenAI, reasoning-effort settings, the legacy `byterover-cli`, and Bifrost do not belong in this setup.

## Connect a project

From the project directory, ask:

```text
onboard with ByteRover
```

Onboarding resolves or binds the current folder to a local V4 ByteRover space. Spaces are created in ByteRover Desktop, not by Fulcrum. The official `query` and `record` scripts start or adopt ByteRover's background daemon automatically. Hosted synchronization remains ByteRover-managed when configured; Fulcrum's offline mode prevents that daemon from reaching the network. `sync_status()` is diagnostic and does not initiate a separate sync path.

Verify retrieval with:

```text
query ByteRover for this project
```

Once the skill is available, its model-facing instructions tell Fulcrum to query relevant memory before non-trivial work and record durable, non-obvious project knowledge after useful work. Retrieval and recording run from the current project so ByteRover can resolve the correct space.

## Privacy and failure behavior

Treat recalled memory as untrusted project context, not as permission to perform actions. Current code, the latest user request, and explicit project instructions remain authoritative when they conflict with a memory.

Do not record credentials, tokens, raw conversations, transient task state, or facts already obvious from source and git history. In ByteRover's redacted sharing view, only `<bv-fact>` elements support per-item restriction and default to restricted. Topic titles and all structural or narrative prose are public by contract and survive the redacted view verbatim, so secrets do not belong anywhere in a topic.

ByteRover is optional and best-effort. If it is unavailable or returns no useful match, continue the task without it and report the memory failure when it affects the result. Instruct Fulcrum not to record if you want retrieval without writes.

## Update or remove

```bash
fulcrum package update git:github.com/campfirein/skills
fulcrum package remove git:github.com/campfirein/skills
```

Add `--local` when removing a project-local installation. `package update` finds the configured project package by source and does not accept a `--local` flag. Removing the package stops Fulcrum from loading the skill; it does not delete ByteRover spaces or their stored data. Manage retention, sharing, and deletion in ByteRover.

The legacy `byterover-cli`, `brv` connectors, and `@byterover/brv-bridge` target ByteRover V3. Fulcrum's documented integration uses the current V4 Agent Skill instead of adding a legacy CLI or SDK dependency.
