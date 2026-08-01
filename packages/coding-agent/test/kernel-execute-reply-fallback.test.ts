import { describe, expect, it, vi } from "vitest";
import { KernelManager, type KernelReconcileOutcome } from "../src/core/kernel/index.js";

const DELIM = Buffer.from("<IDS|MSG>");

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
	for (let i = 0; i < 20; i++) {
		if (mock.mock.calls.length >= count) {
			return;
		}
		await Promise.resolve();
	}
	expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
}

interface JupyterWireMessage {
	header: { msg_type: string };
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface ManagerInternals {
	activeExecution?: { requestMsgId: string; gotExecuteReply: boolean };
	handleShellMessage: (incoming: JupyterWireMessage) => void;
	handleExecutionMessage: (incoming: JupyterWireMessage) => void;
}

const FAKE_CONNECTION = {
	ip: "127.0.0.1",
	transport: "tcp",
	shell_port: 1,
	iopub_port: 2,
	stdin_port: 3,
	control_port: 4,
	hb_port: 5,
	signature_scheme: "hmac-sha256",
	key: "test-key",
	kernel_name: "python3",
};

function makeManager(overrides?: { controlReceive?: () => Promise<Buffer[]> }): {
	manager: KernelManager;
	internals: ManagerInternals;
	shellSend: ReturnType<typeof vi.fn>;
	controlSend: ReturnType<typeof vi.fn>;
} {
	const manager = new KernelManager({ cwd: process.cwd() });
	const shellSend = vi.fn(async (_frames: Buffer[]) => {});
	const controlSend = vi.fn(async (_frames: Buffer[]) => {});
	Object.assign(manager as unknown as Record<string, unknown>, {
		state: "running",
		connection: FAKE_CONNECTION,
		shell: { send: shellSend, close: vi.fn() },
		control: {
			send: controlSend,
			receive: overrides?.controlReceive ?? (() => new Promise<Buffer[]>(() => {})),
			close: vi.fn(),
		},
		start: async () => {},
	});
	return { manager, internals: manager as unknown as ManagerInternals, shellSend, controlSend };
}

function executeReply(requestMsgId: string, content: Record<string, unknown> = { status: "ok" }): JupyterWireMessage {
	return {
		header: { msg_type: "execute_reply" },
		parent_header: { msg_id: requestMsgId },
		metadata: {},
		content,
	};
}

function iopubIdle(requestMsgId: string): JupyterWireMessage {
	return {
		header: { msg_type: "status" },
		parent_header: { msg_id: requestMsgId },
		metadata: {},
		content: { execution_state: "idle" },
	};
}

/** Extract the header msg_id from frames the manager sent (encode layout: DELIM, sig, header, ...). */
function sentMsgId(frames: Buffer[]): string {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	return (JSON.parse(frames[i + 2].toString()) as { msg_id: string }).msg_id;
}

describe("KernelManager execute_reply completion fallback", () => {
	it("finishes an execution via execute_reply when the IOPub idle event is lost", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();

			const executePromise = manager.execute("print('ping')");
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			expect(execution).toBeDefined();

			// The kernel finishes the cell; the matching IOPub idle never arrives.
			internals.handleShellMessage(executeReply(execution!.requestMsgId));
			await vi.advanceTimersByTimeAsync(2500);

			await expect(executePromise).resolves.toMatchObject({ status: "ok" });

			// The serial queue must drain: a follow-up cell reaches the kernel.
			const secondPromise = manager.execute("x = 1");
			await waitForCalls(shellSend, 2);
			const second = internals.activeExecution;
			expect(second).toBeDefined();
			internals.handleExecutionMessage(iopubIdle(second!.requestMsgId));
			await expect(secondPromise).resolves.toMatchObject({ status: "ok" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps IOPub idle as the authoritative completion path when it arrives", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();

			const executePromise = manager.execute("1 + 1");
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(executeReply(execution!.requestMsgId));
			internals.handleExecutionMessage(iopubIdle(execution!.requestMsgId));

			await expect(executePromise).resolves.toMatchObject({ status: "ok" });
			// The grace timer was cleared; advancing time must not blow up on a stale execution.
			await vi.advanceTimersByTimeAsync(5000);
			expect(internals.activeExecution).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("propagates an execute_reply error status when IOPub is lost", async () => {
		vi.useFakeTimers();
		try {
			const { manager, internals, shellSend } = makeManager();

			const executePromise = manager.execute("boom()");
			await waitForCalls(shellSend, 1);
			const execution = internals.activeExecution;
			internals.handleShellMessage(
				executeReply(execution!.requestMsgId, {
					status: "error",
					ename: "RuntimeError",
					evalue: "boom",
					traceback: ["Traceback: boom"],
				}),
			);
			await vi.advanceTimersByTimeAsync(2500);

			await expect(executePromise).resolves.toMatchObject({
				status: "error",
				error: { ename: "RuntimeError", evalue: "boom" },
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("KernelManager.reconcileBackgroundedExecution", () => {
	it("flushes an execution whose execute_reply arrived but whose idle never did", async () => {
		const { manager, internals, shellSend } = makeManager();

		const executePromise = manager.execute("print('ping')");
		await waitForCalls(shellSend, 1);
		const execution = internals.activeExecution;
		internals.handleShellMessage(executeReply(execution!.requestMsgId));

		// Reconcile fires before the idle grace period elapses.
		const outcome: KernelReconcileOutcome = await manager.reconcileBackgroundedExecution(50);
		expect(outcome).toBe("flushed-after-reply");
		await expect(executePromise).resolves.toMatchObject({ status: "ok" });
		expect(internals.activeExecution).toBeUndefined();

		void manager.execute("x = 1");
		await waitForCalls(shellSend, 2);
	});

	it("reports kernel-unresponsive when the control channel never answers", async () => {
		const { manager, internals, shellSend, controlSend } = makeManager();

		void manager.execute("while True: pass").catch(() => undefined);
		await waitForCalls(shellSend, 1);
		expect(internals.activeExecution).toBeDefined();

		const outcome = await manager.reconcileBackgroundedExecution(50);
		expect(outcome).toBe("kernel-unresponsive");
		expect(controlSend).toHaveBeenCalled();
	});

	it("reports kernel-responsive when the control channel answers the probe", async () => {
		const controlSent: Buffer[][] = [];
		let releaseReply: (frames: Buffer[]) => void = () => {};
		const replyFrames = new Promise<Buffer[]>((resolve) => {
			releaseReply = resolve;
		});
		const { manager, internals, shellSend, controlSend } = makeManager({
			controlReceive: () => replyFrames,
		});
		controlSend.mockImplementation(async (frames: Buffer[]) => {
			controlSent.push(frames);
		});

		void manager.execute("import time; time.sleep(600)").catch(() => undefined);
		await waitForCalls(shellSend, 1);

		const outcomePromise = manager.reconcileBackgroundedExecution(2000);
		await waitForCalls(controlSend, 1);
		const requestMsgId = sentMsgId(controlSent[0]);
		releaseReply([
			DELIM,
			Buffer.from("signature"),
			Buffer.from(JSON.stringify({ msg_type: "kernel_info_reply", msg_id: "reply-1" })),
			Buffer.from(JSON.stringify({ msg_id: requestMsgId })),
			Buffer.from("{}"),
			Buffer.from("{}"),
		]);

		await expect(outcomePromise).resolves.toBe("kernel-responsive");
		expect(internals.activeExecution).toBeDefined();
	});

	it("returns no-active-execution when nothing is running", async () => {
		const { manager } = makeManager();
		await expect(manager.reconcileBackgroundedExecution(50)).resolves.toBe("no-active-execution");
	});
});
