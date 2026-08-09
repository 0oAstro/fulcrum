import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { formatCommandHelp, formatTopLevelHelp } from "../src/cli/command-registry.js";
import { GATEWAY_WORKER_MARKER } from "../src/cli/gateway-command.js";
import { loadWhatsAppGatewayConfig } from "../src/gateway/config.js";
import {
	type GatewayConversationProcessor,
	type GatewayInboundMessage,
	type GatewayMessageSender,
	LatestMessageCoordinator,
	shouldRotateConversation,
} from "../src/gateway/conversation-coordinator.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "fulcrum-gateway-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function inbound(id: string, text = id): GatewayInboundMessage {
	return {
		id,
		chatId: "person@s.whatsapp.net",
		text,
		sentAt: new Date("2026-08-08T10:00:00.000Z"),
		media: [],
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			resolvePromise?.(value);
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for gateway test condition");
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
}

describe("WhatsApp gateway configuration", () => {
	test("is gated off by default", () => {
		const agentDir = temporaryDirectory();
		const config = loadWhatsAppGatewayConfig(agentDir, "/workspace");

		expect(config.enabled).toBe(false);
		expect(config.allowGroups).toBe(false);
		expect(config.rotation).toEqual({ inactivityHours: 2, dailyAt: "04:00" });
		expect(config.authDir).toBe(join(agentDir, "gateway", "whatsapp-auth"));
	});

	test("loads the dedicated WhatsApp settings object", () => {
		const agentDir = temporaryDirectory();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				whatsapp: {
					enabled: true,
					allowGroups: true,
					allowedChats: ["one@s.whatsapp.net"],
					models: ["anthropic/model-one", "openai/model-two"],
					rotation: { inactivityHours: false, dailyAt: "05:30" },
				},
			}),
		);

		const config = loadWhatsAppGatewayConfig(agentDir, "/workspace");

		expect(config.enabled).toBe(true);
		expect(config.allowGroups).toBe(true);
		expect(config.allowedChats).toEqual(new Set(["one@s.whatsapp.net"]));
		expect(config.models).toEqual(["anthropic/model-one", "openai/model-two"]);
		expect(config.rotation).toEqual({ inactivityHours: false, dailyAt: "05:30" });
	});

	test("rejects malformed conversation rotation", () => {
		const agentDir = temporaryDirectory();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ whatsapp: { enabled: true, rotation: { dailyAt: "25:00" } } }),
		);

		expect(() => loadWhatsAppGatewayConfig(agentDir, "/workspace")).toThrow("whatsapp.rotation.dailyAt");
	});
});

describe("latest-message coordination", () => {
	test("interrupts stale work and sends only the newest response", async () => {
		const first = deferred<string>();
		const processed: string[] = [];
		const interrupts: string[] = [];
		const sent: string[] = [];
		const processor: GatewayConversationProcessor = {
			async process(message) {
				processed.push(message.id);
				return message.id === "first" ? first.promise : "fresh response";
			},
			interrupt(chatId) {
				interrupts.push(chatId);
			},
			async reset() {},
		};
		const sender: GatewayMessageSender = {
			async sendText(_chatId, text) {
				sent.push(text);
			},
		};
		const coordinator = new LatestMessageCoordinator(processor, sender);

		coordinator.accept(inbound("first"));
		await waitFor(() => processed.length === 1);
		coordinator.accept(inbound("second"));
		first.resolve("stale response");
		await waitFor(() => sent.length === 1);

		expect(interrupts).toEqual(["person@s.whatsapp.net"]);
		expect(processed).toEqual(["first", "second"]);
		expect(sent).toEqual(["fresh response"]);
	});

	test("coalesces queued messages so the latest pending message wins", async () => {
		const first = deferred<string>();
		const processed: string[] = [];
		const sent: string[] = [];
		const coordinator = new LatestMessageCoordinator(
			{
				async process(message) {
					processed.push(message.id);
					return message.id === "first" ? first.promise : message.id;
				},
				interrupt() {},
				async reset() {},
			},
			{
				async sendText(_chatId, text) {
					sent.push(text);
				},
			},
		);

		coordinator.accept(inbound("first"));
		await waitFor(() => processed.length === 1);
		coordinator.accept(inbound("second"));
		coordinator.accept(inbound("third"));
		first.resolve("stale");
		await waitFor(() => sent.length === 1);

		expect(processed).toEqual(["first", "third"]);
		expect(sent).toEqual(["third"]);
	});
});

describe("conversation rotation", () => {
	test("rotates after inactivity", () => {
		expect(
			shouldRotateConversation(new Date(2026, 7, 8, 8, 0), new Date(2026, 7, 8, 7, 0), new Date(2026, 7, 8, 10, 0), {
				inactivityHours: 2,
				dailyAt: false,
			}),
		).toBe(true);
	});

	test("rotates once a local daily boundary passes", () => {
		expect(
			shouldRotateConversation(
				new Date(2026, 7, 8, 3, 59),
				new Date(2026, 7, 8, 3, 30),
				new Date(2026, 7, 8, 4, 1),
				{ inactivityHours: false, dailyAt: "04:00" },
			),
		).toBe(true);
	});
});

describe("gateway command help", () => {
	test("uses the Fulcrum worker marker", () => {
		expect(GATEWAY_WORKER_MARKER).toBe("__fulcrum_gateway_worker__");
	});

	test("documents detached lifecycle commands", () => {
		expect(formatTopLevelHelp()).toContain("gateway");
		expect(formatCommandHelp(["gateway"])).toContain("always runs as a detached background process");
		expect(formatCommandHelp(["gateway", "restart"])).toContain("gateway restart");
	});
});
