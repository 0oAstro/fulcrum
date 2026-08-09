import { clearGatewayPidForCurrentProcess, writeGatewayRuntimeStatus } from "../cli/gateway-command.js";
import { loadWhatsAppGatewayConfig } from "./config.js";
import { WhatsAppGateway } from "./whatsapp.js";

export async function runGatewayWorker(): Promise<void> {
	process.umask(0o077);
	const config = loadWhatsAppGatewayConfig();
	if (!config.enabled) throw new Error("WhatsApp gateway is disabled");
	const gateway = new WhatsAppGateway(config);
	let resolveShutdown: (() => void) | undefined;
	const shutdown = new Promise<void>((resolve) => {
		resolveShutdown = resolve;
	});
	const stop = () => {
		void gateway.stop().finally(() => resolveShutdown?.());
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await gateway.start();
		await shutdown;
	} catch (error) {
		writeGatewayRuntimeStatus({
			state: "error",
			updatedAt: new Date().toISOString(),
			detail: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		await gateway.stop();
		clearGatewayPidForCurrentProcess();
	}
}
