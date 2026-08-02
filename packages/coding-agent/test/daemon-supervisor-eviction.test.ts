import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, idleEvictionSweepIntervalMs } from "../src/modes/daemon/daemon-supervisor.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		ownerClientId?: string;
		stopRequestedAt?: string;
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
	};
	summaries: Map<string, SessionSummary>;
	intentionalStop: boolean;
	updateRestartPrepareClient?: object;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	clients: Set<{ id: string; attachedActiveSessionIds: Set<string> }>;
	catalog: { resolve: ReturnType<typeof vi.fn> };
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	runIdleEvictionSweep(now?: number): Promise<void>;
	handleCommand(client: object, command: object): Promise<unknown>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSummary(id: string, now: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date(now - 120 * 60_000).toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeWorker(id: string, summaries: SessionSummary[]): WorkerFixture {
	const client = {
		request: vi.fn(async () => success(undefined, "list", { sessions: summaries })),
		requestWorker: vi.fn(),
	};
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready",
			rootActiveSessionId: `${id}-descriptor-root`,
			rootSessionId: `${id}-root-session`,
			pid: 1,
		},
		client,
		summaries: new Map(summaries.map((summary) => [summary.activeSessionId ?? summary.id, summary])),
		intentionalStop: false,
	};
}

function makeSupervisor(idleEvictionMinutes: number | "off" = 90): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-eviction-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({ idleEvictionMinutes }));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.stopWorker = vi.fn(async (worker: WorkerFixture) => {
		supervisor.workers.delete(worker.descriptor.workerId);
	});
	supervisor.log = vi.fn();
	return supervisor;
}

describe("daemon supervisor whole-tree eviction", () => {
	it("derives a bounded sweep interval from the live threshold", () => {
		expect(idleEvictionSweepIntervalMs("off")).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(90)).toBe(5 * 60_000);
		expect(idleEvictionSweepIntervalMs(6)).toBe(2 * 60_000);
		expect(idleEvictionSweepIntervalMs(1)).toBe(60_000);
	});

	it("stops a fully idle worker and leaves pinned workers resident", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const idle = makeWorker("idle", [makeSummary("idle-root", now), makeSummary("idle-child", now)]);
		const active = makeWorker("active", [makeSummary("active-root", now, { isSessionActive: true })]);
		const heartbeat = makeWorker("heartbeat", [makeSummary("heartbeat-root", now, { hasRegisteredHeartbeat: true })]);
		const cron = makeWorker("cron", [makeSummary("cron-root", now, { hasRegisteredCronJob: true })]);
		const attached = makeWorker("attached", [makeSummary("attached-root", now)]);
		for (const worker of [idle, active, heartbeat, cron, attached]) {
			supervisor.workers.set(worker.descriptor.workerId, worker);
		}
		supervisor.clients.add({ id: "viewer", attachedActiveSessionIds: new Set(["attached-root"]) });

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(idle, true);
		expect(supervisor.log).toHaveBeenCalledWith(
			expect.stringMatching(/Evicted idle worker idle .*idleMinutes=120 sessions=2/),
		);
		expect([...supervisor.workers.keys()].sort()).toEqual(["active", "attached", "cron", "heartbeat"]);
	});

	it("uses canonical busy state so a stale parent with a running child is not evicted", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const parent = makeWorker("parent", [makeSummary("parent-root", now, { hasRunningRlmChildren: true })]);
		supervisor.workers.set("parent", parent);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(supervisor.workers.has("parent")).toBe(true);
	});

	it("evicts a paused-heartbeat session but pins an active-heartbeat session", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const paused = makeWorker("paused", [makeSummary("paused-root", now)]);
		const active = makeWorker("active-heartbeat", [
			makeSummary("active-heartbeat-root", now, { hasRegisteredHeartbeat: true }),
		]);
		supervisor.workers.set("paused", paused);
		supervisor.workers.set("active-heartbeat", active);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(paused, true);
		expect(supervisor.workers.has("active-heartbeat")).toBe(true);
	});

	it("honors off after reloading settings at sweep time", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor("off");
		const idle = makeWorker("idle", [makeSummary("idle-root", now)]);
		supervisor.workers.set("idle", idle);

		await supervisor.runIdleEvictionSweep(now);

		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		expect(idle.client?.request).not.toHaveBeenCalled();
	});

	it("reopens an inactive saved session through the existing create path used before attach", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const rootSummary = makeSummary("new-active-id", now, {
			sessionId: "saved-session",
			sessionFile: "/tmp/saved.jsonl",
		});
		const reopened = makeWorker("reopened", [rootSummary]);
		reopened.descriptor.rootActiveSessionId = "new-active-id";
		supervisor.createOrReuseWorker = vi.fn(async () => reopened);
		const client = { id: "viewer", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "create-1",
			type: "create",
			sessionPath: "/tmp/saved.jsonl",
			continueRecent: false,
		});

		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"viewer",
			expect.objectContaining({ sessionPath: "/tmp/saved.jsonl" }),
		);
		expect(response).toMatchObject({
			success: true,
			command: "create",
			data: { activeSessionId: "new-active-id", sessionId: "saved-session" },
		});
	});

	it("wakes a saved target before cross-worker agent-message delivery", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const sourceSummary = makeSummary("source-active", now, { sessionId: "source-session" });
		const source = makeWorker("source", [sourceSummary]);
		source.summaries = new Map([["source-active", sourceSummary]]);
		const targetSummary = makeSummary("target-active", now, {
			sessionId: "target-session",
			sessionFile: "/tmp/target.jsonl",
		});
		const target = makeWorker("target", [targetSummary]);
		target.descriptor.rootActiveSessionId = "target-active";
		target.client!.requestWorker.mockResolvedValue({
			type: "response",
			command: "worker_deliver_message",
			success: true,
			data: { deliveryStatus: "delivered" },
		});
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => "/tmp/target.jsonl");
		supervisor.createOrReuseWorker = vi.fn(async () => target);
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		const response = await supervisor.handleCommand(client, {
			id: "message-1",
			type: "send_message",
			targetActiveSessionId: "target-session",
			fromActiveSessionId: "source-active",
			message: "wake up",
		});

		expect(supervisor.catalog.resolve).toHaveBeenCalledWith("target-session", "/tmp/project", undefined);
		expect(supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"sender",
			expect.objectContaining({ type: "create", sessionPath: "/tmp/target.jsonl", continueRecent: false }),
		);
		expect(target.client?.requestWorker).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "worker_deliver_message",
				targetActiveSessionId: "target-active",
				message: "wake up",
			}),
			24 * 60 * 60 * 1000,
		);
		expect(response).toMatchObject({ success: true, id: "message-1", command: "send_message" });
	});

	it("propagates an ambiguous saved-session selector during a2a wake", async () => {
		const now = Date.parse("2026-08-01T12:00:00.000Z");
		const supervisor = makeSupervisor();
		const source = makeWorker("source", [makeSummary("source-active", now)]);
		supervisor.workers.set("source", source);
		supervisor.catalog.resolve = vi.fn(async () => {
			throw new Error('Ambiguous session selector "target"');
		});
		supervisor.createOrReuseWorker = vi.fn();
		const client = { id: "sender", attachedActiveSessionIds: new Set<string>() };

		await expect(
			supervisor.handleCommand(client, {
				id: "message-ambiguous",
				type: "send_message",
				targetActiveSessionId: "target",
				fromActiveSessionId: "source-active",
				message: "wake up",
			}),
		).rejects.toThrow('Ambiguous session selector "target"');
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});
});
