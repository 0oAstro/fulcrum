#!/usr/bin/env node

import { runGatewayWorker } from "./worker.js";

await runGatewayWorker().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
