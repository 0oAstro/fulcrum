import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getAwsProfileConfig } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAwsRegion = process.env.AWS_REGION;
const originalAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
const originalAwsProfile = process.env.AWS_PROFILE;
const originalAwsEndpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
const originalAwsConfigFile = process.env.AWS_CONFIG_FILE;
const originalAwsSharedCredentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE;

beforeEach(() => {
	bedrockMock.constructorCalls.length = 0;
	delete process.env.AWS_REGION;
	delete process.env.AWS_DEFAULT_REGION;
	delete process.env.AWS_PROFILE;
	delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	delete process.env.AWS_CONFIG_FILE;
	delete process.env.AWS_SHARED_CREDENTIALS_FILE;
});

afterEach(() => {
	if (originalAwsRegion === undefined) {
		delete process.env.AWS_REGION;
	} else {
		process.env.AWS_REGION = originalAwsRegion;
	}

	if (originalAwsDefaultRegion === undefined) {
		delete process.env.AWS_DEFAULT_REGION;
	} else {
		process.env.AWS_DEFAULT_REGION = originalAwsDefaultRegion;
	}

	if (originalAwsProfile === undefined) {
		delete process.env.AWS_PROFILE;
	} else {
		process.env.AWS_PROFILE = originalAwsProfile;
	}

	if (originalAwsEndpoint === undefined) {
		delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	} else {
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = originalAwsEndpoint;
	}

	if (originalAwsConfigFile === undefined) {
		delete process.env.AWS_CONFIG_FILE;
	} else {
		process.env.AWS_CONFIG_FILE = originalAwsConfigFile;
	}

	if (originalAwsSharedCredentialsFile === undefined) {
		delete process.env.AWS_SHARED_CREDENTIALS_FILE;
	} else {
		process.env.AWS_SHARED_CREDENTIALS_FILE = originalAwsSharedCredentialsFile;
	}
});

async function captureClientConfig(model: Model<"bedrock-converse-stream">): Promise<Record<string, unknown>> {
	await streamBedrock(model, context, { cacheRetention: "none" }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

describe("bedrock endpoint resolution", () => {
	it("assigns eu-central-1 runtime URLs to built-in EU inference profiles", () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		expect(model.baseUrl).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
	});

	it("does not pin standard AWS endpoints when AWS_REGION is configured", async () => {
		process.env.AWS_REGION = "us-east-2";
		const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-east-2");
		expect(config.endpoint).toBeUndefined();
	});

	it("honors the AWS Bedrock runtime endpoint override", async () => {
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "https://bedrock-proxy.example.com";
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-proxy.example.com");
	});

	it("uses the shared default profile region without pinning the catalog endpoint", async () => {
		const fixtureDir = mkdtempSync(join(tmpdir(), "pi-bedrock-profile-"));
		try {
			writeFileSync(join(fixtureDir, "config"), "[default]\nregion = eu-west-1\n");
			writeFileSync(
				join(fixtureDir, "credentials"),
				"[default]\naws_access_key_id = test-access-key\naws_secret_access_key = test-secret-key\n",
			);
			process.env.AWS_CONFIG_FILE = join(fixtureDir, "config");
			process.env.AWS_SHARED_CREDENTIALS_FILE = join(fixtureDir, "credentials");

			await vi.waitFor(() => {
				expect(getAwsProfileConfig()).toMatchObject({
					profile: "default",
					region: "eu-west-1",
					hasCredentialSource: true,
				});
			});

			const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");
			const config = await captureClientConfig(model);

			expect(config.region).toBe("eu-west-1");
			expect(config.endpoint).toBeUndefined();
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	it("derives region from a built-in EU endpoint when no region or profile is configured", async () => {
		const model = getModel("amazon-bedrock", "eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");
	});

	it("still passes custom Bedrock endpoints through to the SDK client", async () => {
		process.env.AWS_REGION = "us-west-2";
		const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-7");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			baseUrl: "https://bedrock-vpc.example.com",
		};

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-vpc.example.com");
		expect(config.region).toBe("us-west-2");
	});
});
