import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";

const ACTIVE_SESSION_ID = "active-restart";
const SNAPSHOT_ID = "snap-restart-1";

function beginPayload(): Buffer {
	return Buffer.from(
		`${JSON.stringify({
			type: "session_snapshot_begin",
			activeSessionId: ACTIVE_SESSION_ID,
			snapshotId: SNAPSHOT_ID,
			messageCount: 2,
			targetChunkBytes: 1024,
			snapshot: {
				summary: {
					id: ACTIVE_SESSION_ID,
					activeSessionId: ACTIVE_SESSION_ID,
					sessionId: "session-1",
					cwd: "/tmp",
					lifecycle: "running",
					activity: "idle",
					isStreaming: false,
					isCompacting: false,
					attachedClients: 1,
					messageCount: 2,
					pendingMessageCount: 0,
				},
				state: {},
				messages: [],
				lastEventSequence: 7,
			},
		})}\n`,
	);
}

/**
 * A worker legitimately restarts an in-flight snapshot transfer when a second
 * catch-up lands mid-stream. Killing the worker connection over it takes the
 * whole session down: `prompt_and_wait` fails with "Daemon worker client
 * closed" and the agent run exits 1 (observed on a Luna analyzer fanning out
 * to eight child readers). The restart must be absorbed instead.
 */
describe("DaemonSupervisor snapshot restart tolerance", () => {
	it("accepts a restarted in-flight snapshot without closing the worker", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-snapshot-restart-"));
		try {
			const close = vi.fn();
			const handleWorkerClose = vi.fn();
			const transcript = new SnapshotTranscriptCache({
				activeSessionId: ACTIVE_SESSION_ID,
				snapshotId: SNAPSHOT_ID,
				cacheRoot: root,
				targetChunkBytes: 1024,
			});
			const generation = {
				transcript,
				result: {
					activeSessionId: ACTIVE_SESSION_ID,
					lastEventSequence: 7,
					snapshot: { lastEventSequence: 7 },
					snapshotStream: { id: SNAPSHOT_ID, messageCount: 2, targetChunkBytes: 1024 },
				},
				// A transfer of this very snapshot is already in flight.
				incoming: true,
				retired: false,
			};
			const generations = new Map([[SNAPSHOT_ID, generation]]);
			const worker = {
				client: { close },
				snapshotCache: new Map(),
				transcriptCaches: new Map([[ACTIVE_SESSION_ID, transcript]]),
				snapshotGenerations: new Map([[ACTIVE_SESSION_ID, generations]]),
				snapshotTransferFrames: new Map(),
				incomingTranscriptActiveSessionIds: new Set(),
				duplicateIncomingTranscriptChunkIndexes: new Map(),
			};
			const logged: string[] = [];
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				clients: new Set(),
				snapshotCacheRoot: root,
				handleWorkerClose,
				log: (message: string) => logged.push(message),
				publicSummary: (_worker: unknown, summary: unknown) => summary,
				write: vi.fn(),
			}) as {
				handleWorkerFrame(worker: unknown, frame: unknown): void;
			};

			supervisor.handleWorkerFrame(worker, {
				header: {
					kind: "outbound",
					outboundType: "session_snapshot_begin",
					activeSessionId: ACTIVE_SESSION_ID,
					snapshotId: SNAPSHOT_ID,
				},
				payload: beginPayload(),
			});

			// The worker connection survives — this is the whole point.
			expect(close).not.toHaveBeenCalled();
			expect(handleWorkerClose).not.toHaveBeenCalled();
			expect(logged.some((line) => line.includes("restarted before completion"))).toBe(true);

			// The stale partial transfer is gone and the restart is now the live
			// generation, accepting chunks again.
			const live = (
				worker.snapshotGenerations.get(ACTIVE_SESSION_ID) as Map<string, { incoming: boolean }>
			).get(SNAPSHOT_ID);
			expect(live).toBeDefined();
			expect(live?.incoming).toBe(true);
			expect(live).not.toBe(generation);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
