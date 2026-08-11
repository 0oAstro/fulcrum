# Fulcrum

A self-improving RLM agent.

Fulcrum is an open-source coding and research agent for general and long-running work. It is designed around two core abstractions:

- The **Recursive Language Model (RLM)** treats context as variables (*prompt-as-a-variable*) and tools like recursive subagents as function calls (*programmatic tool /sub-agent calling*) inside a persistent REPL.
- The **[Continual Harness](https://arxiv.org/abs/2605.09998)** stores supplemental prompts, memories, skill descriptions, and reusable subagent specifications as durable state that Fulcrum can refine through small, evidence-backed updates, local to the session by default.

Fulcrum combines a persistent Python control environment with durable harness state, so useful working context and reusable operating patterns can outlive a single chat window.

- **Everything is programmatic:** persistent IPython is the built-in model tool; file operations, shell commands, tool use, subagents, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents for parallel or background work and returns their results programmatically.
- **The harness can improve:** `/refine` reviews the current trajectory and can apply small, evidence-backed updates to supplemental harness state. It never rewrites the immutable base system prompt, and recorded snapshots support rollback.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Project memory is extensible:** ByteRover V4 can be installed as an optional Agent Skill for durable project or team context without replacing the built-in continual harness.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

Run Fulcrum from this checkout:

```bash
./fulcrum.sh
```

Start Fulcrum from the repository or directory you want it to work in:

```bash
cd /path/to/project
fulcrum
```

On first launch, run `/login` to choose a subscription or API-key provider. Fulcrum works in the current directory and can run commands and modify files there. Use a disposable clone, clean worktree, or another checkpoint you can inspect and restore.

> [!WARNING]
> Fulcrum executes model-generated Python and project commands with your user permissions. Its worker and kernel processes improve lifecycle isolation and recovery; they are **not** a security sandbox. Review changes and use trusted repositories, instructions, skills, and extensions only. Run untrusted code or instructions in an external sandbox or restricted environment.

Useful commands:

```bash
fulcrum agents                   # Browse running, idle, and saved sessions
fulcrum attach <agent>           # Reattach to a running session
fulcrum --resume <path|id>       # Resume a saved session
fulcrum status                   # Inspect background service state
fulcrum doctor [--fix]           # Inspect or repair background services
fulcrum update [--force]         # Update Fulcrum
fulcrum shutdown [--force]       # Stop every agent, worker, and background service
```

## Releases and updates

The `0oAstro/fulcrum` fork publishes GitHub Releases from `main`. Push local changes to that fork; the release workflow publishes the beta channel, and installed beta copies can pull the result with:

```bash
git push fork main
fulcrum update
```

Stable releases are published from version tags or a manual stable workflow run.

## Built for Long-Running Work
Fulcrum is built for long-running work, especially for evaluations in research. These features are available in the TUI, and when run autonomously.

- **Continual Harness:** `/refine` can persist focused, reviewable lessons as supplemental prompts, memories, reusable skill descriptions, or subagent specifications, with recorded refinement history. It does not replace packaging and reviewing new executable skills.
- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, and steer active work.
- **Daemon-backed continuity:** active sessions, IPython state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `fulcrum schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues within configured turn, token, and time budgets and can run user-defined quality gates. A passed gate checks only what that gate verifies; reaching a limit does not imply task success.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md) — install, authenticate, and run a first session
- [Usage and CLI reference](packages/coding-agent/docs/usage.md) — commands, sessions, autonomous limits, and output modes
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md) — detach and reattach, goals, heartbeats, and schedules
- [RLM programming model](packages/coding-agent/docs/rlm.md) — persistent IPython, subagents, skills, and the trust model
- [JSON mode](packages/coding-agent/docs/json.md) and [RPC mode](packages/coding-agent/docs/rpc.md) — headless automation and integrations
- [Skills](packages/coding-agent/docs/skills.md) — install and create reusable capabilities
- [ByteRover memory](packages/coding-agent/docs/byterover.md) — optional durable project and team context
- [Provider setup](packages/coding-agent/docs/providers.md) — subscription and API-key providers
- [Architecture overview](packages/coding-agent/docs/architecture.md) — daemon, worker, kernel, and persistence boundaries
- [Development](packages/coding-agent/docs/development.md) — build and run from source

## Acknowledgements

Our agent and TUI is built on top of [`pi`](https://github.com/earendil-works/pi). We thank the authors of `pi` for their valuable work.

## License

Fulcrum is fully open source and released under the [MIT License](LICENSE).
