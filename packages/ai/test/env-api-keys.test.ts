import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAwsProfileConfig, getEnvApiKey } from "../src/env-api-keys.js";

const awsEnvironmentNames = [
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
] as const;

const originalAwsEnvironment = Object.fromEntries(
	awsEnvironmentNames.map((name) => [name, process.env[name]]),
) as Record<(typeof awsEnvironmentNames)[number], string | undefined>;

function clearAwsEnvironment(): void {
	for (const name of awsEnvironmentNames) delete process.env[name];
}

function restoreAwsEnvironment(): void {
	for (const name of awsEnvironmentNames) {
		const value = originalAwsEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreAwsEnvironment();
});

describe("AWS environment credential hints", () => {
	it("recognizes static credentials in the selected shared default profile", async () => {
		clearAwsEnvironment();
		const fixtureDir = mkdtempSync(join(tmpdir(), "pi-aws-profile-"));
		try {
			writeFileSync(join(fixtureDir, "config"), "[default]\nregion = eu-west-1\n");
			writeFileSync(
				join(fixtureDir, "credentials"),
				"[default]\naws_access_key_id = test-access-key\naws_secret_access_key = test-secret-key\n",
			);
			process.env.AWS_CONFIG_FILE = join(fixtureDir, "config");
			process.env.AWS_SHARED_CREDENTIALS_FILE = join(fixtureDir, "credentials");

			await vi.waitFor(() => {
				expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
			});
			expect(getAwsProfileConfig()).toEqual({
				profile: "default",
				region: "eu-west-1",
				hasProfile: true,
				hasCredentialSource: true,
			});
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	it("does not select an arbitrary named profile when AWS_PROFILE is unset", async () => {
		clearAwsEnvironment();
		const fixtureDir = mkdtempSync(join(tmpdir(), "pi-aws-profile-"));
		try {
			writeFileSync(
				join(fixtureDir, "credentials"),
				"[personal]\naws_access_key_id = key\naws_secret_access_key = secret\n",
			);
			process.env.AWS_SHARED_CREDENTIALS_FILE = join(fixtureDir, "credentials");

			await vi.waitFor(() => {
				expect(getAwsProfileConfig()).toBeUndefined();
			});
			expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	it("recognizes configured credential_process and SSO profiles without executing them", async () => {
		clearAwsEnvironment();
		const fixtureDir = mkdtempSync(join(tmpdir(), "pi-aws-profile-"));
		try {
			writeFileSync(
				join(fixtureDir, "config"),
				"[default]\ncredential_process = /bin/false\nsso_start_url = https://example.awsapps.com/start\n",
			);
			process.env.AWS_CONFIG_FILE = join(fixtureDir, "config");

			await vi.waitFor(() => {
				expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
			});
			expect(getAwsProfileConfig()?.hasCredentialSource).toBe(true);
		} finally {
			rmSync(fixtureDir, { recursive: true, force: true });
		}
	});
});
