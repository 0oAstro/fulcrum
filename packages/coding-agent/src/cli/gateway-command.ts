import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as qrcode from "qrcode-terminal";
import { APP_NAME, getAgentDir } from "../config.js";
import { loadWhatsAppGatewayConfig } from "../gateway/config.js";

export const GATEWAY_WORKER_MARKER = "__fulcrum_gateway_worker__";

interface GatewayPidRecord {
	pid: number;
	startedAt: string;
	marker: typeof GATEWAY_WORKER_MARKER;
}

export interface GatewayRuntimeStatus {
	state: "starting" | "connected" | "disconnected" | "error";
	updatedAt: string;
	detail?: string;
}

export interface GatewayPairingMaterial {
	type: "qr" | "code";
	value: string;
	updatedAt: string;
}

interface GatewayPaths {
	directory: string;
	pid: string;
	log: string;
	status: string;
	pairing: string;
}

function gatewayPaths(): GatewayPaths {
	const config = loadWhatsAppGatewayConfig();
	return {
		directory: config.dataDir,
		pid: join(config.dataDir, "gateway.pid.json"),
		log: join(config.dataDir, "gateway.log"),
		status: join(config.dataDir, "gateway.status.json"),
		pairing: join(config.dataDir, "gateway.pairing.json"),
	};
}

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function readPidRecord(path: string): GatewayPidRecord | undefined {
	const record = readJsonFile<GatewayPidRecord>(path);
	if (
		!record ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		record.marker !== GATEWAY_WORKER_MARKER ||
		typeof record.startedAt !== "string"
	) {
		return undefined;
	}
	return record;
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "EPERM"
		);
	}
}

function isGatewayWorker(pid: number): boolean {
	if (!isProcessRunning(pid)) return false;
	if (process.platform !== "linux") return true;
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(GATEWAY_WORKER_MARKER);
	} catch {
		return false;
	}
}

function removeStalePidFile(paths: GatewayPaths): void {
	const record = readPidRecord(paths.pid);
	if (!record || !isGatewayWorker(record.pid)) {
		rmSync(paths.pid, { force: true });
	}
}

export function writeGatewayRuntimeStatus(status: GatewayRuntimeStatus): void {
	const paths = gatewayPaths();
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	writeFileSync(paths.status, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
}

export function clearGatewayPidForCurrentProcess(): void {
	const paths = gatewayPaths();
	const record = readPidRecord(paths.pid);
	if (record?.pid === process.pid) {
		rmSync(paths.pid, { force: true });
	}
}

export function writeGatewayPairingMaterial(material: GatewayPairingMaterial | undefined): void {
	const paths = gatewayPaths();
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	if (!material) {
		rmSync(paths.pairing, { force: true });
		return;
	}
	writeFileSync(paths.pairing, `${JSON.stringify(material, null, 2)}\n`, { mode: 0o600 });
}

function printPairingMaterial(material: GatewayPairingMaterial): void {
	if (material.type === "code") {
		console.log(`WhatsApp pairing code: ${material.value}`);
		return;
	}
	console.log("Scan this QR in WhatsApp: Settings > Linked devices > Link a device.");
	qrcode.generate(material.value, { small: true }, (rendered) => console.log(rendered));
}

async function waitForPairingMaterial(
	paths: GatewayPaths,
	timeoutMs: number,
): Promise<GatewayPairingMaterial | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const material = readJsonFile<GatewayPairingMaterial>(paths.pairing);
		if (material?.value && (material.type === "qr" || material.type === "code")) return material;
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	return undefined;
}

async function startGateway(): Promise<void> {
	const config = loadWhatsAppGatewayConfig();
	if (!config.enabled) {
		throw new Error(
			`WhatsApp gateway is disabled. Set "whatsapp.enabled" to true in ${getAgentDir()}/settings.json.`,
		);
	}
	const paths = gatewayPaths();
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	removeStalePidFile(paths);
	const existing = readPidRecord(paths.pid);
	if (existing && isGatewayWorker(existing.pid)) {
		console.log(`Gateway is already running (pid ${existing.pid}).`);
		return;
	}
	rmSync(paths.pairing, { force: true });
	writeGatewayRuntimeStatus({ state: "starting", updatedAt: new Date().toISOString() });

	const logFd = openSync(paths.log, "a", 0o600);
	let child: ChildProcess;
	try {
		const workerExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
		const workerPath = fileURLToPath(new URL(`../gateway/worker-cli.${workerExtension}`, import.meta.url));
		child = spawn(process.execPath, [...process.execArgv, workerPath, GATEWAY_WORKER_MARKER], {
			cwd: process.cwd(),
			detached: true,
			env: { ...process.env },
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
		});
	} finally {
		closeSync(logFd);
	}
	if (!child.pid) {
		throw new Error("Failed to launch the gateway worker");
	}
	const record: GatewayPidRecord = {
		pid: child.pid,
		startedAt: new Date().toISOString(),
		marker: GATEWAY_WORKER_MARKER,
	};
	writeFileSync(paths.pid, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	child.unref();
	console.log(`Gateway started in the background (pid ${child.pid}).`);
	console.log(`Log: ${paths.log}`);
	const pairing = await waitForPairingMaterial(paths, 2000);
	if (pairing) {
		printPairingMaterial(pairing);
	} else {
		console.log(`If pairing is required, run "${APP_NAME} gateway pair".`);
	}
}

async function stopGateway(quiet = false): Promise<void> {
	const paths = gatewayPaths();
	const record = readPidRecord(paths.pid);
	if (!record || !isGatewayWorker(record.pid)) {
		rmSync(paths.pid, { force: true });
		if (!quiet) console.log("Gateway is stopped.");
		return;
	}
	process.kill(record.pid, "SIGTERM");
	const deadline = Date.now() + 5000;
	while (isGatewayWorker(record.pid) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	if (isGatewayWorker(record.pid)) {
		process.kill(record.pid, "SIGKILL");
	}
	rmSync(paths.pid, { force: true });
	writeGatewayRuntimeStatus({ state: "disconnected", updatedAt: new Date().toISOString(), detail: "Stopped" });
	if (!quiet) console.log("Gateway stopped.");
}

function statusGateway(): void {
	const paths = gatewayPaths();
	const record = readPidRecord(paths.pid);
	if (!record || !isGatewayWorker(record.pid)) {
		rmSync(paths.pid, { force: true });
		console.log("Gateway: stopped");
		console.log(`Log: ${paths.log}`);
		return;
	}
	const runtime = readJsonFile<GatewayRuntimeStatus>(paths.status);
	console.log(`Gateway: ${runtime?.state ?? "running"} (pid ${record.pid})`);
	if (runtime?.detail) console.log(`Detail: ${runtime.detail}`);
	console.log(`Started: ${record.startedAt}`);
	console.log(`Log: ${paths.log}`);
}

function showPairingMaterial(): void {
	const paths = gatewayPaths();
	const material = readJsonFile<GatewayPairingMaterial>(paths.pairing);
	if (!material?.value || (material.type !== "qr" && material.type !== "code")) {
		throw new Error(`No active pairing request. Start the gateway, then retry "${APP_NAME} gateway pair".`);
	}
	printPairingMaterial(material);
}

export async function handleGatewayCommand(args: string[]): Promise<void> {
	const command = args[0];
	if (!command || args.length !== 1 || !["start", "stop", "status", "restart", "pair"].includes(command)) {
		throw new Error(`Usage: ${APP_NAME} gateway <start|stop|status|restart|pair>`);
	}
	switch (command) {
		case "start":
			await startGateway();
			return;
		case "stop":
			await stopGateway();
			return;
		case "status":
			statusGateway();
			return;
		case "restart":
			await stopGateway(true);
			await startGateway();
			return;
		case "pair":
			showPairingMaterial();
			return;
	}
}
