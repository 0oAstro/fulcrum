import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { buildRlmBootstrapCode } from "../src/core/tools/ipython.js";

describe("IPython RLM bootstrap", () => {
	it("pre-imports asyncio so the prompt's subagent patterns work without a manual import", () => {
		expect(buildRlmBootstrapCode()).toMatch(/^import asyncio$/m);
	});

	it("defines persistent websearch and browser modules over typed host requests", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain("websearch = _fulcrum_builtin_module(");
		expect(code).toContain("browser = _fulcrum_builtin_module(");
		expect(code).toContain('_fulcrum_host_request("websearch.search", payload)');
		expect(code).toContain('"websearch.open"');
		expect(code).toContain('"websearch.fetch"');
		expect(code).toContain('_fulcrum_host_request("websearch.map", {"url": url, "limit": limit})');
	});

	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain('async def find_models(self, query="", limit=8)');
		expect(code).toContain("async def list_subagents(self)");
		expect(code).toContain("async def delete_subagent(self, target)");
		expect(code).toContain("self._raise_missing()");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('_fulcrum_os.environ["NO_COLOR"] = "1"');
	});

	it("guards Python skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("except Exception as _fulcrum_skill_error");
		expect(code).toContain("_FulcrumUnavailableSkill");
		expect(code).toContain("_FULCRUM_SKILL_IMPORT_ERRORS");
		expect(code).toContain("globals()[_fulcrum_skill_name] = _FulcrumUnavailableSkill");
	});
});

/** Find a python that can launch an ipykernel, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.FULCRUM_KERNEL_PYTHON,
		join(homedir(), ".fulcrum", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("IPython RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "fulcrum-bootstrap-"));

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("binds asyncio in the user namespace", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute("_t = asyncio.create_task(asyncio.sleep(0))\nprint(type(_t).__name__)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("Task");

			const bashResult = await manager.execute('%%bash\nprintf %s "$NO_COLOR"');
			expect(bashResult.status).toBe("ok");
			expect(bashResult.stdout).toBe("1");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("pre-imports persistent websearch and browser modules with public signatures", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			hostHandlers: {
				"websearch.search": async (payload) => {
					requests.push({ type: "websearch.search", payload });
					return { text: "Search result" };
				},
				"websearch.research": async (payload) => {
					requests.push({ type: "websearch.research", payload });
					return { text: "Research result [1]" };
				},
				"websearch.open": async (payload) => {
					requests.push({ type: "websearch.open", payload });
					return { text: "Page" };
				},
				"websearch.fetch": async (payload) => {
					requests.push({ type: "websearch.fetch", payload });
					return { text: "Focused page" };
				},
				"websearch.map": async (payload) => {
					requests.push({ type: "websearch.map", payload });
					return { links: ["https://example.com/a"] };
				},
			},
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute(`
import inspect, json
print(inspect.signature(websearch.search))
print(inspect.signature(websearch.research))
print(inspect.signature(websearch.open))
print(inspect.signature(browser.fetch))
print(inspect.signature(websearch.map))
print(websearch.__doc__)
print(json.dumps(await websearch.search("fulcrum", include_domains=["example.com"]), sort_keys=True))
print(json.dumps(await websearch.research("fulcrum architecture", queries=["official fulcrum"]), sort_keys=True))
print(json.dumps(await websearch.open("https://example.com"), sort_keys=True))
print(json.dumps(await browser.fetch("https://example.com", "Extract facts"), sort_keys=True))
print(json.dumps(await websearch.map("https://example.com", limit=7), sort_keys=True))
`);
			expect(result.status, JSON.stringify(result)).toBe("ok");
			expect(result.stdout).toContain("(query, limit=5, include_domains=None, exclude_domains=None, recency=None)");
			expect(result.stdout).toContain(
				"(topic, queries=None, max_queries=4, follow_up_queries=2, results_per_query=5, max_sources=8, instruction=None, include_domains=None, exclude_domains=None, recency=None)",
			);
			expect(result.stdout).toContain("(url, formats=['markdown'], only_main_content=True)");
			expect(result.stdout).toContain("(url, instruction='Extract the useful page content.', max_output=12000)");
			expect(result.stdout).toContain("(url, limit=100)");
			expect(result.stdout).toContain("Persistent first-party web discovery, page, site-map, and research helpers");
			expect(result.stdout).toContain('"Search result"');
			expect(result.stdout).toContain('"Research result [1]"');
			expect(result.stdout).toContain('"Page"');
			expect(result.stdout).toContain('"Focused page"');
			expect(result.stdout).toContain('{"links": ["https://example.com/a"]}');

			const persistent = await manager.execute("print(websearch.__name__, browser.__name__)");
			expect(persistent.status).toBe("ok");
			expect(persistent.stdout.trim()).toBe("websearch browser");

			expect(requests).toHaveLength(5);
			expect(requests[0]).toMatchObject({
				type: "websearch.search",
				payload: { query: "fulcrum", limit: 5, include_domains: ["example.com"] },
			});
			expect(requests[0].payload).not.toHaveProperty("exclude_domains");
			expect(requests[0].payload).not.toHaveProperty("recency");
			expect(requests[1]).toMatchObject({
				type: "websearch.research",
				payload: {
					topic: "fulcrum architecture",
					queries: ["official fulcrum"],
					max_queries: 4,
					follow_up_queries: 2,
					results_per_query: 5,
					max_sources: 8,
				},
			});
			expect(requests[2]).toMatchObject({
				type: "websearch.open",
				payload: { url: "https://example.com", formats: ["markdown"], only_main_content: true },
			});
			expect(requests[3]).toMatchObject({
				type: "websearch.fetch",
				payload: { url: "https://example.com", instruction: "Extract facts", max_output: 12000 },
			});
			expect(requests[4]).toMatchObject({
				type: "websearch.map",
				payload: { url: "https://example.com", limit: 7 },
			});
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("emits canonical paths for edits after the kernel changes directories", async () => {
		const firstDir = join(dir, "first");
		const secondDir = join(dir, "second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(firstDir, "same.txt"), "old");
		writeFileSync(join(secondDir, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			env: { PYTHONPATH: join(editSkillRoot, "src") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "edit",
						importName: "edit",
						packagePath: editSkillRoot,
						pyprojectPath: join(editSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const first = await manager.execute(
				'import os\nos.chdir("first")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);
			const second = await manager.execute(
				'os.chdir("../second")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);

			expect(first.diffs?.[0]?.path).toBe(realpathSync(join(firstDir, "same.txt")));
			expect(second.diffs?.[0]?.path).toBe(realpathSync(join(secondDir, "same.txt")));
			expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});
