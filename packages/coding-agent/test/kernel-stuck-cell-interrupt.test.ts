import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager, type KernelReconcileOutcome } from "../src/core/kernel/index.js";
import { createIpythonToolDefinition, type IpythonToolDetails } from "../src/core/tools/ipython.js";

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
	activeExecution?: {
		requestMsgId: string;
		gotExecuteReply: boolean;
		stdout: string;
		silentReconcilePolls?: number;
	};
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

/** Header fields of a message the manager sent (encode layout: DELIM, sig, header, ...). */
function sentHeader(frames: Buffer[]): { msg_id: string; msg_type: string } {
	let i = 0;
	while (i < frames.length && !frames[i].equals(DELIM)) i++;
	return JSON.parse(frames[i + 2].toString()) as { msg_id: string; msg_type: string };
}

function kernelInfoReply(requestMsgId: string): Buffer[] {
	return [
		DELIM,
		Buffer.from("signature"),
		Buffer.from(JSON.stringify({ msg_type: "kernel_info_reply", msg_id: `reply-${requestMsgId}` })),
		Buffer.from(JSON.stringify({ msg_id: requestMsgId })),
		Buffer.from("{}"),
		Buffer.from("{}"),
	];
}

function iopubIdle(requestMsgId: string): JupyterWireMessage {
	return {
		header: { msg_type: "status" },
		parent_header: { msg_id: requestMsgId },
		metadata: {},
		content: { execution_state: "idle" },
	};
}

/**
 * Manager whose control channel answers every liveness probe (the stuck-cell
 * signature: kernel alive, execution never finishing). `onInterrupt` fires
 * when an interrupt_request goes out on the control channel.
 */
function makeResponsiveManager(onInterrupt?: () => void): {
	manager: KernelManager;
	internals: ManagerInternals;
	shellSend: ReturnType<typeof vi.fn>;
	interruptCount: () => number;
} {
	const manager = new KernelManager({ cwd: process.cwd() });
	const shellSend = vi.fn(async (_frames: Buffer[]) => {});
	let interrupts = 0;
	// Queue-based control channel: send() may happen before or after the
	// manager registers its receive(), so replies buffer until consumed.
	const replyQueue: Buffer[][] = [];
	let replyWaiter: ((frames: Buffer[]) => void) | undefined;
	const deliverReply = (frames: Buffer[]) => {
		if (replyWaiter) {
			const waiter = replyWaiter;
			replyWaiter = undefined;
			waiter(frames);
		} else {
			replyQueue.push(frames);
		}
	};
	const controlSend = vi.fn(async (frames: Buffer[]) => {
		const header = sentHeader(frames);
		if (header.msg_type === "kernel_info_request") {
			deliverReply(kernelInfoReply(header.msg_id));
		} else if (header.msg_type === "interrupt_request") {
			interrupts++;
			onInterrupt?.();
		}
	});
	Object.assign(manager as unknown as Record<string, unknown>, {
		state: "running",
		connection: FAKE_CONNECTION,
		shell: { send: shellSend, close: vi.fn() },
		control: {
			send: controlSend,
			receive: () =>
				new Promise<Buffer[]>((resolve) => {
					const next = replyQueue.shift();
					if (next) {
						resolve(next);
					} else {
						replyWaiter = resolve;
					}
				}),
			close: vi.fn(),
		},
		start: async () => {},
	});
	return {
		manager,
		internals: manager as unknown as ManagerInternals,
		shellSend,
		interruptCount: () => interrupts,
	};
}

describe("KernelManager stuck-cell auto-interrupt escalation", () => {
	beforeEach(() => {
		process.env.PRIME_AGENT_IPYTHON_STUCK_CELL_GRACE_MS = "100";
	});
	afterEach(() => {
		delete process.env.PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS;
		delete process.env.PRIME_AGENT_IPYTHON_STUCK_CELL_GRACE_MS;
	});

	it("interrupts a silent stuck cell after the poll threshold and reports auto-interrupted", async () => {
		const state = { internals: undefined as ManagerInternals | undefined };
		const { manager, internals, shellSend, interruptCount } = makeResponsiveManager(() => {
			// The interrupt lands: the kernel aborts the cell and goes idle.
			const execution = state.internals?.activeExecution;
			if (execution) {
				setTimeout(() => state.internals?.handleExecutionMessage(iopubIdle(execution.requestMsgId)), 10);
			}
		});
		state.internals = internals;

		const executePromise = manager.execute("await never_resolves()").catch(() => undefined);
		await waitForCalls(shellSend, 1);
		expect(internals.activeExecution).toBeDefined();

		// Two silent polls stay informational; no interrupt goes out.
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(interruptCount()).toBe(0);

		// The third silent poll escalates, the interrupt clears the cell.
		const outcome: KernelReconcileOutcome = await manager.reconcileBackgroundedExecution(2000);
		expect(outcome).toBe("auto-interrupted");
		expect(interruptCount()).toBe(1);
		await executePromise;
		expect(internals.activeExecution).toBeUndefined();
	});

	it("resets the silent-poll counter when the cell produces new output", async () => {
		const { manager, internals, shellSend, interruptCount } = makeResponsiveManager();

		void manager.execute("long_chatty_work()").catch(() => undefined);
		await waitForCalls(shellSend, 1);

		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		// Progress output arrives between polls: the cell is working, not stuck.
		internals.activeExecution!.stdout += "step 3/10 done\n";
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(internals.activeExecution!.silentReconcilePolls).toBe(0);
		// The next poll starts the count over instead of escalating.
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(interruptCount()).toBe(0);
	});

	it("reports kernel-wedged once repeated interrupts provably do nothing", async () => {
		process.env.PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS = "1";
		const { manager, shellSend, interruptCount } = makeResponsiveManager();

		void manager.execute("c_extension_holding_the_gil()").catch(() => undefined);
		await waitForCalls(shellSend, 1);

		// Each poll past the threshold burns one interrupt attempt (grace 100ms).
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(interruptCount()).toBe(1);
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-responsive");
		expect(interruptCount()).toBe(2);
		// Attempts exhausted: the caller must restart the kernel.
		expect(await manager.reconcileBackgroundedExecution(2000)).toBe("kernel-wedged");
		expect(interruptCount()).toBe(2);
	});
});

describe("ipython tool kernel-wedged handling", () => {
	afterEach(() => {
		delete process.env.PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS;
	});

	it("kills the kernel and tells the agent to resubmit when reconciliation reports a wedge", async () => {
		process.env.PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS = "50";
		const kill = vi.fn(async () => {});
		const provisioner = {
			ensure: async () => ({
				execute: () => new Promise(() => {}),
			}),
			markStartupBackgrounded: () => {},
			reconcileBackgroundedExecution: async () => "kernel-wedged" as const,
			kill,
		};
		const tool = createIpythonToolDefinition(process.cwd(), {
			provisioner: provisioner as never,
		});

		const result = await tool.execute(
			"call-1",
			{ code: "print('queued behind the wedge')" },
			undefined,
			undefined,
			undefined as unknown as Parameters<typeof tool.execute>[4],
		);
		const details = result.details as IpythonToolDetails;

		expect(kill).toHaveBeenCalledTimes(1);
		expect(details.reconcileOutcome).toBe("kernel-wedged");
		expect(details.kernelRestarted).toBe(true);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("kernel was killed");
		expect(text).toContain("resubmit");
	});
});
