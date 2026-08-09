import type { existsSync, readFileSync, statSync } from "node:fs";
import type { homedir } from "node:os";
import type { join } from "node:path";
import type { KnownProvider } from "./types.js";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
let _existsSync: typeof existsSync | null = null;
let _readFileSync: typeof readFileSync | null = null;
let _statSync: typeof statSync | null = null;
let _homedir: typeof homedir | null = null;
let _join: typeof join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

let envApiKeysReady = Promise.resolve();

// Eagerly load in Node.js/Bun environment only
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	const fsPromise = dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		_existsSync = (m as { existsSync: typeof existsSync }).existsSync;
		_readFileSync = (m as { readFileSync: typeof readFileSync }).readFileSync;
		_statSync = (m as { statSync: typeof statSync }).statSync;
	});
	const osPromise = dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_homedir = (m as { homedir: typeof homedir }).homedir;
	});
	const pathPromise = dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		_join = (m as { join: typeof join }).join;
	});
	// A browser-compatible build may reject a node: import. Keep readiness
	// best-effort, matching the existing synchronous availability semantics.
	envApiKeysReady = Promise.all([fsPromise, osPromise, pathPromise]).then(
		() => undefined,
		() => undefined,
	);
}

/** Wait for Node's browser-safe environment helpers to finish loading. */
export async function waitForEnvApiKeysReady(): Promise<void> {
	await envApiKeysReady;
}

// Node 22+ exposes built-ins synchronously. Use that path when available so
// startup model discovery does not race the browser-safe dynamic imports.
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	try {
		const getBuiltinModule = process.getBuiltinModule;
		if (getBuiltinModule) {
			const fs = getBuiltinModule("node:fs") as {
				existsSync: typeof existsSync;
				readFileSync: typeof readFileSync;
				statSync: typeof statSync;
			};
			const os = getBuiltinModule("node:os") as { homedir: typeof homedir };
			const path = getBuiltinModule("node:path") as { join: typeof join };
			_existsSync ??= fs.existsSync;
			_readFileSync ??= fs.readFileSync;
			_statSync ??= fs.statSync;
			_homedir ??= os.homedir;
			_join ??= path.join;
		}
	} catch {
		// Older Node versions fall back to the dynamic imports above.
	}
}

let _procEnvCache: Map<string, string> | null = null;

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802
 * Bun compiled binaries have an empty `process.env` inside sandbox
 * environments on Linux. We can recover the env from `/proc/self/environ`.
 */
function getProcEnv(key: string): string | undefined {
	if (typeof process === "undefined" || !process.versions?.bun) return undefined;

	// If process.env already has entries, the bug is not triggered.
	if (Object.keys(process.env).length > 0) return undefined;

	if (_procEnvCache === null) {
		_procEnvCache = new Map();
		try {
			const { readFileSync: readProcEnvFile } = require("node:fs") as { readFileSync: typeof readFileSync };
			const data = readProcEnvFile("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					_procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ may not be readable.
		}
	}

	return _procEnvCache.get(key);
}

export type AwsProfileConfig = {
	/** Profile selected by the AWS SDK credential/configuration chain. */
	profile: string;
	/** Region declared by the selected shared AWS config profile. */
	region?: string;
	/** Whether either shared file contains a section for this profile. */
	hasProfile: boolean;
	/** Whether the profile describes a credential source the SDK can use. */
	hasCredentialSource: boolean;
};

/**
 * Read an environment value, including Bun's /proc fallback.
 *
 * This is intentionally a synchronous hint only. The AWS SDK remains the
 * authority for resolving and refreshing credentials when a request is sent.
 */
export function getAwsEnvironmentValue(name: string): string | undefined {
	if (typeof process === "undefined") return undefined;
	return process.env[name] || getProcEnv(name);
}

type AwsIni = Record<string, Record<string, string>>;

function parseAwsIni(content: string): AwsIni {
	const sections: AwsIni = {};
	let current: Record<string, string> | undefined;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;

		const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
		if (sectionMatch) {
			const sectionName = sectionMatch[1]!.trim().replace(/^profile\s+/i, "");
			current = sections[sectionName] ?? {};
			sections[sectionName] = current;
			continue;
		}

		if (!current) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (key) current[key] = value;
	}

	return sections;
}

function readAwsIni(path: string | undefined): AwsIni {
	if (!path || !_existsSync || !_readFileSync || !_existsSync(path)) return {};
	try {
		return parseAwsIni(_readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function getAwsConfigPath(name: "config" | "credentials"): string | undefined {
	const environmentName = name === "config" ? "AWS_CONFIG_FILE" : "AWS_SHARED_CREDENTIALS_FILE";
	const override = getAwsEnvironmentValue(environmentName);
	if (override) return override;
	if (!_homedir || !_join) return undefined;
	return _join(_homedir(), ".aws", name);
}

function hasAwsCredentialSource(profile: string, config: AwsIni, credentials: AwsIni, visited: Set<string>): boolean {
	if (visited.has(profile)) return false;
	visited.add(profile);

	const values = { ...(config[profile] ?? {}), ...(credentials[profile] ?? {}) };
	if (values.aws_access_key_id && values.aws_secret_access_key) return true;
	if (values.credential_process) return true;
	if (values.sso_start_url || values.sso_session || (values.sso_account_id && values.sso_role_name)) return true;
	if (values.web_identity_token_file) return true;
	if (values.credential_source) return true;

	if (values.role_arn && values.source_profile) {
		return hasAwsCredentialSource(values.source_profile, config, credentials, visited);
	}

	return false;
}

let cachedAwsProfileLookup: { key: string; result: AwsProfileConfig | undefined } | undefined;

function getAwsFileFingerprint(path: string | undefined): string {
	if (!path || !_statSync) return "unavailable";
	try {
		const stat = _statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

/**
 * Resolve the selected shared AWS profile enough for model availability and
 * endpoint hints. This deliberately does not execute credential_process,
 * refresh SSO tokens, or contact metadata services; BedrockRuntimeClient does
 * that asynchronously when it sends a request.
 */
export function getAwsProfileConfig(profile?: string): AwsProfileConfig | undefined {
	// The dynamic Node imports above may not have completed during module startup.
	// Do not cache a negative result until every path helper is ready.
	if (!_existsSync || !_readFileSync || !_statSync || !_homedir || !_join) return undefined;

	const selectedProfile = profile || getAwsEnvironmentValue("AWS_PROFILE") || "default";
	const configPath = getAwsConfigPath("config");
	const credentialsPath = getAwsConfigPath("credentials");
	const cacheKey = `${selectedProfile}\0${configPath ?? ""}\0${credentialsPath ?? ""}\0${getAwsFileFingerprint(configPath)}\0${getAwsFileFingerprint(credentialsPath)}`;
	if (cachedAwsProfileLookup?.key === cacheKey) return cachedAwsProfileLookup.result;

	const config = readAwsIni(configPath);
	const credentials = readAwsIni(credentialsPath);
	const configValues = config[selectedProfile];
	const credentialValues = credentials[selectedProfile];
	const hasProfile = Boolean(configValues || credentialValues);
	if (!hasProfile) {
		cachedAwsProfileLookup = { key: cacheKey, result: undefined };
		return undefined;
	}

	const result: AwsProfileConfig = {
		profile: selectedProfile,
		...(configValues?.region || credentialValues?.region
			? { region: configValues?.region ?? credentialValues?.region }
			: {}),
		hasProfile: true,
		hasCredentialSource: hasAwsCredentialSource(selectedProfile, config, credentials, new Set()),
	};
	cachedAwsProfileLookup = { key: cacheKey, result };
	return result;
}

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		// If node modules haven't loaded yet (async import race at startup),
		// return false WITHOUT caching so the next call retries once they're ready.
		// Only cache false permanently in a browser environment where fs is never available.
		if (!_existsSync || !_homedir || !_join) {
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			if (!isNode) {
				// Definitively in a browser — safe to cache false permanently
				cachedVertexAdcCredentialsExists = false;
			}
			return false;
		}

		// Check GOOGLE_APPLICATION_CREDENTIALS env var first (standard way)
		const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || getProcEnv("GOOGLE_APPLICATION_CREDENTIALS");
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// Fall back to default ADC path (lazy evaluation)
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "github-copilot") {
		return ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];
	}

	// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
	if (provider === "anthropic") {
		return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		moonshotai: "MOONSHOT_API_KEY",
		"moonshotai-cn": "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 *
 * This only reports actual API key variables. It intentionally excludes ambient
 * credential sources such as AWS profiles, AWS IAM credentials, and Google
 * Application Default Credentials.
 */
export function findEnvKeys(provider: KnownProvider): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	const found = envVars.filter((envVar) => !!process.env[envVar] || !!getProcEnv(envVar));
	return found.length > 0 ? found : undefined;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: string): string | undefined {
	const envKeys = findEnvKeys(provider);
	if (envKeys?.[0]) {
		return process.env[envKeys[0]] || getProcEnv(envKeys[0]);
	}

	// Vertex AI supports either an explicit API key or Application Default Credentials.
	// Auth is configured via `gcloud auth application-default login`.
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!(
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.GCLOUD_PROJECT ||
			getProcEnv("GOOGLE_CLOUD_PROJECT") ||
			getProcEnv("GCLOUD_PROJECT")
		);
		const hasLocation = !!(process.env.GOOGLE_CLOUD_LOCATION || getProcEnv("GOOGLE_CLOUD_LOCATION"));

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	if (provider === "amazon-bedrock") {
		// Amazon Bedrock supports the AWS SDK default credential chain. This
		// synchronous check is only an availability hint; the SDK remains
		// responsible for resolving, refreshing, and validating credentials.
		const accessKeyId = getAwsEnvironmentValue("AWS_ACCESS_KEY_ID");
		const secretAccessKey = getAwsEnvironmentValue("AWS_SECRET_ACCESS_KEY");
		if (
			getAwsEnvironmentValue("AWS_PROFILE") ||
			(accessKeyId && secretAccessKey) ||
			getAwsEnvironmentValue("AWS_BEARER_TOKEN_BEDROCK") ||
			getAwsEnvironmentValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
			getAwsEnvironmentValue("AWS_CONTAINER_CREDENTIALS_FULL_URI") ||
			getAwsEnvironmentValue("AWS_WEB_IDENTITY_TOKEN_FILE") ||
			getAwsProfileConfig()?.hasCredentialSource
		) {
			return "<authenticated>";
		}
	}

	return undefined;
}
