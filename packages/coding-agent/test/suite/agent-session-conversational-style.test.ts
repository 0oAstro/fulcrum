import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

interface CommunicationProfile {
	direct: boolean;
	natural: boolean;
	toneAware: boolean;
}

function inferCommunicationProfile(systemPrompt: string): CommunicationProfile {
	const words = new Set(systemPrompt.toLowerCase().match(/[a-z]+/g) ?? []);
	const includesAny = (candidates: string[]): boolean => candidates.some((candidate) => words.has(candidate));
	return {
		direct: includesAny(["concise", "concrete", "canned"]),
		natural: includesAny(["collaborator", "warmth", "wit", "flatter"]),
		toneAware: includesAny(["formality", "casing", "emoji"]),
	};
}

function retryCountFromToolResult(messages: ReadonlyArray<Message>): string | undefined {
	const result = messages.find(
		(message) => message.role === "toolResult" && message.toolName === "inspect_retry_policy",
	);
	return result ? /retry limit:\s*(\d+)/i.exec(getMessageText(result))?.[1] : undefined;
}

function latestUserText(messages: ReadonlyArray<Message>): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return getMessageText(messages[index]);
	}
	return "";
}

describe("default conversational style", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("answers tool-backed questions directly in a natural voice", async () => {
		let inspections = 0;
		const inspectRetryPolicy: AgentTool = {
			name: "inspect_retry_policy",
			label: "Inspect retry policy",
			description: "Read the configured retry count",
			parameters: Type.Object({}),
			execute: async () => {
				inspections++;
				return {
					content: [{ type: "text", text: "retry limit: 3" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [inspectRetryPolicy] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_retry_policy", {}), { stopReason: "toolUse" }),
			(context) => {
				const count = retryCountFromToolResult(context.messages);
				const profile = inferCommunicationProfile(context.systemPrompt ?? "");
				if (!count) return fauxAssistantMessage("I could not inspect the retry policy.");
				if (profile.direct && profile.natural && profile.toneAware) {
					const spokenCount = count === "3" ? "three" : count;
					return fauxAssistantMessage(
						`${spokenCount} retries. stubborn enough for a flaky network, not enough to hold the terminal hostage.`,
					);
				}
				return fauxAssistantMessage(`Certainly! The retry limit is ${count}. Would you like anything else?`);
			},
		]);

		await harness.session.prompt("how many retries do we use?");

		expect(inspections).toBe(1);
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"inspect_retry_policy",
		]);
		expect(getAssistantTexts(harness).at(-1)).toBe(
			"three retries. stubborn enough for a flaky network, not enough to hold the terminal hostage.",
		);
	});

	it("keeps the user's explicit output format authoritative", async () => {
		const inspectRetryPolicy: AgentTool = {
			name: "inspect_retry_policy",
			label: "Inspect retry policy",
			description: "Read the configured retry count",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "retry limit: 3" }],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [inspectRetryPolicy] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("inspect_retry_policy", {}), { stopReason: "toolUse" }),
			(context) => {
				const count = retryCountFromToolResult(context.messages);
				const requestedFormat = /^answer with only RETRIES=<count> in uppercase$/i.test(
					latestUserText(context.messages),
				);
				return fauxAssistantMessage(requestedFormat && count ? `RETRIES=${count}` : "RETRIES=UNKNOWN");
			},
		]);

		await harness.session.prompt("answer with only RETRIES=<count> in uppercase");

		expect(harness.eventsOfType("tool_execution_end").map((event) => event.toolName)).toEqual([
			"inspect_retry_policy",
		]);
		expect(getAssistantTexts(harness).at(-1)).toBe("RETRIES=3");
	});
});
