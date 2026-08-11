import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import type { IpythonKernelProvisioner } from "../../src/core/tools/ipython.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

function createByteRoverFixture(): { root: string; skill: Skill } {
	const root = mkdtempSync(join(tmpdir(), "fulcrum-byterover-suite-"));
	const scriptsDir = join(root, "scripts");
	mkdirSync(scriptsDir, { recursive: true });
	writeFileSync(join(root, "SKILL.md"), "# ByteRover fixture\n");
	writeFileSync(
		join(scriptsDir, "query.mjs"),
		`console.error("fixture warning");
console.log(JSON.stringify({ ok: true, query: process.argv[2], limit: process.argv[4], source: "byterover", dataDir: process.env.BRV_DATA_DIR }));
`,
	);
	for (const script of ["record.mjs", "brv.mjs", "space.mjs", "sync.mjs"]) {
		writeFileSync(
			join(scriptsDir, script),
			`console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));
`,
		);
	}
	return {
		root,
		skill: {
			name: "byterover",
			description: "Retrieve and record durable project memory.",
			filePath: join(root, "SKILL.md"),
			baseDir: root,
			sourceInfo: createSyntheticSourceInfo(join(root, "SKILL.md"), { source: "test" }),
			disableModelInvocation: false,
			kind: "markdown",
		},
	};
}

describe("ByteRover Python skill facade", () => {
	const harnesses: Harness[] = [];
	const fixtureRoots: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (fixtureRoots.length > 0) {
			const root = fixtureRoots.pop();
			if (root) rmSync(root, { recursive: true, force: true });
		}
	});

	it("pre-imports the facade and executes the enabled V4 skill runtime", async () => {
		const fixture = createByteRoverFixture();
		fixtureRoots.push(fixture.root);
		const skills = [fixture.skill];
		const resourceLoader = createTestResourceLoader({ skills });
		const dataDir = join(fixture.root, "v4-data");
		const harness = await createHarness({
			resourceLoader,
			settings: { byterover: { dataDir, offline: true } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("ipython", {
					code: `offline = _fulcrum_os.environ.pop("FULCRUM_BYTEROVER_OFFLINE", None)
memory = await byterover.query("auth decisions", limit=4)
recorded = await byterover.record("ops/note", title="Quick note", body="Keep it concise.")
print(memory)
print(recorded)
print(offline)
print(hasattr(byterover, "authenticate"))`,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				const text = getMessageText(result);
				const succeeded =
					text.includes("'source': 'byterover'") &&
					text.includes("'limit': '4'") &&
					text.includes(`'dataDir': '${dataDir}'`) &&
					text.includes("fixture warning") &&
					text.includes("'args': ['ops/note', '--title', 'Quick note', '--body', 'Keep it concise.']") &&
					text.includes("1") &&
					text.includes("False");
				return fauxAssistantMessage(succeeded ? "ByteRover memory loaded." : "ByteRover memory failed.");
			},
		]);

		await harness.session.prompt("query project memory");

		expect(harness.eventsOfType("tool_execution_end").map((event) => event.toolName)).toEqual(["ipython"]);
		expect(getAssistantTexts(harness).at(-1)).toBe("ByteRover memory loaded.");

		skills.splice(0);
		await harness.session.reload();
		const sessionInternals = harness.session as unknown as {
			_ipythonKernelProvisioner?: IpythonKernelProvisioner;
		};
		const kernel = await sessionInternals._ipythonKernelProvisioner?.ensure();
		const disabledResult = await kernel?.execute(`import sys
print("byterover" in globals(), "byterover" in sys.modules)`);

		expect(disabledResult?.status).toBe("ok");
		expect(disabledResult?.stdout.trim()).toBe("False False");
	});
});
