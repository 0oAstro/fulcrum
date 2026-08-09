import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { expandTildePath, getAgentDir } from "../config.js";

export interface WhatsAppRotationConfig {
	inactivityHours: number | false;
	dailyAt: string | false;
}

export interface WhatsAppGatewayConfig {
	enabled: boolean;
	authDir: string;
	dataDir: string;
	mediaDir: string;
	cwd: string;
	pairingPhoneNumber?: string;
	allowGroups: boolean;
	allowedChats?: ReadonlySet<string>;
	models: readonly string[];
	rotation: WhatsAppRotationConfig;
}

const DEFAULT_INACTIVITY_HOURS = 2;
const DEFAULT_DAILY_ROTATION = "04:00";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`whatsapp.${field} must be a non-empty string`);
	}
	return value.trim();
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new Error(`whatsapp.${field} must be a boolean`);
	}
	return value;
}

function resolveConfiguredPath(value: unknown, fallback: string, field: string): string {
	const configured = optionalString(value, field);
	if (!configured) return fallback;
	const expanded = expandTildePath(configured);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function parseStringArray(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`whatsapp.${field} must be an array of non-empty strings`);
	}
	return value.map((item) => (item as string).trim());
}

function parseInactivityHours(value: unknown): number | false {
	if (value === undefined) return DEFAULT_INACTIVITY_HOURS;
	if (value === false) return false;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("whatsapp.rotation.inactivityHours must be a positive number or false");
	}
	return value;
}

function parseDailyAt(value: unknown): string | false {
	if (value === undefined) return DEFAULT_DAILY_ROTATION;
	if (value === false) return false;
	if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
		throw new Error('whatsapp.rotation.dailyAt must use local "HH:MM" time or false');
	}
	return value;
}

function readSettings(agentDir: string): Record<string, unknown> {
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Failed to read WhatsApp configuration from ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(`Settings file must contain a JSON object: ${settingsPath}`);
	}
	return parsed;
}

export function loadWhatsAppGatewayConfig(agentDir = getAgentDir(), cwd = process.cwd()): WhatsAppGatewayConfig {
	const settings = readSettings(agentDir);
	const raw = settings.whatsapp;
	if (raw === undefined) {
		return {
			enabled: false,
			authDir: join(agentDir, "gateway", "whatsapp-auth"),
			dataDir: join(agentDir, "gateway"),
			mediaDir: join(agentDir, "gateway", "media"),
			cwd,
			allowGroups: false,
			models: [],
			rotation: { inactivityHours: DEFAULT_INACTIVITY_HOURS, dailyAt: DEFAULT_DAILY_ROTATION },
		};
	}
	if (!isRecord(raw)) {
		throw new Error("whatsapp must be a configuration object");
	}

	const dataDir = resolveConfiguredPath(raw.dataDir, join(agentDir, "gateway"), "dataDir");
	const rotation = raw.rotation;
	if (rotation !== undefined && !isRecord(rotation)) {
		throw new Error("whatsapp.rotation must be a configuration object");
	}
	const allowedChats = parseStringArray(raw.allowedChats, "allowedChats");
	const models = parseStringArray(raw.models, "models");
	for (const model of models) {
		if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) {
			throw new Error(`whatsapp.models entry must use provider/model format: ${model}`);
		}
	}

	return {
		enabled: optionalBoolean(raw.enabled, "enabled", false),
		authDir: resolveConfiguredPath(raw.authDir, join(dataDir, "whatsapp-auth"), "authDir"),
		dataDir,
		mediaDir: resolveConfiguredPath(raw.mediaDir, join(dataDir, "media"), "mediaDir"),
		cwd: resolveConfiguredPath(raw.cwd, cwd, "cwd"),
		pairingPhoneNumber: optionalString(raw.pairingPhoneNumber, "pairingPhoneNumber")?.replace(/\D/g, ""),
		allowGroups: optionalBoolean(raw.allowGroups, "allowGroups", false),
		allowedChats: allowedChats.length > 0 ? new Set(allowedChats) : undefined,
		models,
		rotation: {
			inactivityHours: parseInactivityHours(rotation?.inactivityHours),
			dailyAt: parseDailyAt(rotation?.dailyAt),
		},
	};
}
