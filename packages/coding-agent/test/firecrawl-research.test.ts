import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirecrawlApiError, type FirecrawlClient, FirecrawlTransportError } from "../src/core/firecrawl-client.js";
import { type FirecrawlResearchTraceEvent, researchFirecrawl } from "../src/core/firecrawl-research.js";
import type { ModelRegistry } from "../src/core/model-registry.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (original) => ({ ...(await original()), completeSimple: completeSimpleMock }));

type Client = Pick<FirecrawlClient, "search" | "scrape">;

function model(): Model<Api> {
	return {
		id: "cheap",
		name: "cheap",
		provider: "test",
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function registry(): ModelRegistry {
	const configuredModel = model();
	return {
		getAll: vi.fn(() => [configuredModel]),
		getAvailable: vi.fn(() => [configuredModel]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "model-key" })),
	} as unknown as ModelRegistry;
}

describe("Firecrawl matrix research", () => {
	beforeEach(() => completeSimpleMock.mockReset());

	it("plans queries, deduplicates sources, scrapes concurrently, and synthesizes citations", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: '["official topic", "topic criticism", "topic current"]' }],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: '{"sufficient":true,"candidate":"answer","unresolved_constraints":[],"queries":[]}',
					},
				],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Primary evidence" [1]\nAnswer [1].\n\nSources\n[1] https://docs.example.com/topic',
					},
				],
			});
		let active = 0;
		let peak = 0;
		const search = vi.fn(async ({ query }: { query: string }) => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			return {
				web: [{ url: "https://docs.example.com/topic?utm_source=x", title: `Docs ${query}`, description: "Fact" }],
				images: [],
				news: [],
			};
		});
		const scrape = vi.fn(async () => ({ metadata: {}, markdown: "Primary evidence" }));
		const output = await researchFirecrawl(
			{ topic: "topic" },
			{ client: { search, scrape } as Client, registry: registry(), researchModel: "test/cheap" },
		);

		expect(search).toHaveBeenCalledTimes(3);
		expect(peak).toBeGreaterThan(1);
		expect(scrape).toHaveBeenCalledTimes(1);
		expect(scrape).toHaveBeenCalledWith(
			{ url: "https://docs.example.com/topic", formats: ["markdown"], onlyMainContent: true },
			undefined,
		);
		expect(output).toContain("Answer [1]");
	});

	it("tolerates partial failures and returns a deterministic source matrix without a model", async () => {
		const traceEvents: FirecrawlResearchTraceEvent[] = [];
		const search = vi.fn(async ({ query }: { query: string }) => {
			if (query === "broken") throw new FirecrawlApiError("secret provider message", 429, "rate_limited");
			return {
				web: [{ url: "https://example.com/a", title: "A", description: "Summary" }],
				images: [],
				news: [],
				warning: "partial index",
				creditsUsed: 2,
			};
		});
		const scrape = vi.fn(async () => ({ metadata: {}, markdown: "Fetched summary content" }));
		const output = await researchFirecrawl(
			{ topic: "topic", queries: ["broken", "working"] },
			{ client: { search, scrape } as Client, onTrace: (event) => traceEvents.push(event) },
		);
		expect(output).toContain("Research: topic");
		expect(output).toContain("https://example.com/a");
		expect(output).toContain("Fetched summary content");
		expect(traceEvents).toContainEqual({
			stage: "search",
			round: "initial",
			query: "broken",
			status: "error",
			error: { kind: "firecrawl", status: 429, code: "rate_limited" },
		});
		expect(traceEvents).toContainEqual(
			expect.objectContaining({
				stage: "search",
				query: "working",
				status: "success",
				warning: "partial index",
				creditsUsed: 2,
			}),
		);
		expect(JSON.stringify(traceEvents)).not.toContain("secret provider message");
	});

	it("reports counted search failure when partial transport failure leaves no evidence", async () => {
		const traceEvents: FirecrawlResearchTraceEvent[] = [];
		const client = {
			search: vi.fn(async ({ query }: { query: string }) => {
				if (query === "first") throw new FirecrawlTransportError("connection included sensitive URL");
				return { web: [], images: [], news: [] };
			}),
			scrape: vi.fn(),
		} as Client;
		await expect(
			researchFirecrawl(
				{ topic: "topic", queries: ["first", "second"] },
				{ client, onTrace: (event) => traceEvents.push(event) },
			),
		).rejects.toThrow("Web research search failed before usable evidence was found (1/2 queries failed).");
		expect(traceEvents).toHaveLength(2);
		expect(traceEvents).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "error", error: { kind: "network" } })]),
		);
		expect(JSON.stringify(traceEvents)).not.toContain("sensitive URL");
	});

	it.each([
		["uncited", "An answer without citations.\n\nSources\n[1] https://example.com/a"],
		["out-of-range", "An answer [2].\n\nSources\n[2] https://example.com/a"],
		["wrong mapping", "An answer [1].\n\nSources\n[1] https://wrong.example/a"],
	])("falls back for %s model synthesis", async (_label, synthesis) => {
		completeSimpleMock.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: synthesis }] });
		const client = {
			search: vi.fn(async () => ({ web: [{ url: "https://example.com/a", title: "A" }], images: [], news: [] })),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Evidence" })),
		} as Client;
		const output = await researchFirecrawl(
			{ topic: "topic", queries: ["topic"], maxFollowUpQueries: 0 },
			{ client, registry: registry(), researchModel: "test/cheap" },
		);
		expect(output).toContain("Research: topic");
		expect(output).toContain("[1] A");
		expect(output).not.toBe(synthesis);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("rejects an exact cited synthesis without direct-evidence calibration", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: 'Evidence calibration: direct [1]\nDirect evidence: "Candidate Z is the exact answer." [1]\nThe exact answer is Candidate Z [1].\n\nSources:\n[1] https://example.com/a',
				},
			],
		});
		const client = {
			search: vi.fn(async () => ({ web: [{ url: "https://example.com/a", title: "A" }], images: [], news: [] })),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Only indirect evidence." })),
		} as Client;
		const output = await researchFirecrawl(
			{ topic: "identify the candidate", queries: ["candidate"], maxFollowUpQueries: 0 },
			{ client, registry: registry(), researchModel: "test/cheap" },
		);
		expect(output).toContain("deterministic evidence matrix");
		expect(output).not.toContain("Candidate Z");
	});

	it("does not treat search markdown or failed scrapes as fetched evidence", async () => {
		const traceEvents: FirecrawlResearchTraceEvent[] = [];
		const client = {
			search: vi.fn(async () => ({
				web: [
					{ url: "https://example.com/empty", title: "Empty", markdown: "Search-only claim." },
					{ url: "https://other.example/failure", title: "Failure", description: "Snippet only." },
				],
				images: [],
				news: [],
			})),
			scrape: vi.fn(async ({ url }: { url: string }) => {
				if (url.includes("failure")) throw new FirecrawlTransportError();
				return { metadata: { statusCode: 200 }, markdown: "" };
			}),
		} as Client;
		await expect(
			researchFirecrawl(
				{ topic: "claim", queries: ["claim"], maxFollowUpQueries: 0 },
				{ client, onTrace: (event) => traceEvents.push(event) },
			),
		).rejects.toThrow("Web research found results but could not fetch usable page content.");
		expect(traceEvents).toContainEqual({
			stage: "scrape",
			url: "https://example.com/empty",
			status: "success",
			usable: false,
			warning: undefined,
			statusCode: 200,
		});
		expect(traceEvents).toContainEqual({
			stage: "scrape",
			url: "https://other.example/failure",
			status: "error",
			error: { kind: "network" },
		});
	});

	it.each([
		["unset", undefined, registry()],
		["unavailable", "test/missing", registry()],
		[
			"unauthenticated",
			"test/cheap",
			{
				getAll: vi.fn(() => [model()]),
				getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, reason: "missing" })),
			} as unknown as ModelRegistry,
		],
	])("does not substitute a model when researchModel is %s", async (_label, researchModel, modelRegistry) => {
		const client = {
			search: vi.fn(async () => ({ web: [{ url: "https://example.com/a", title: "A" }], images: [], news: [] })),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Evidence" })),
		} as Client;
		const output = await researchFirecrawl({ topic: "topic" }, { client, registry: modelRegistry, researchModel });
		expect(client.search).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(output).toContain("configured research model unavailable");
	});

	it("requests PDF results and promotes academic PDF evidence while preserving search markdown", async () => {
		const search = vi.fn(async (_request: { query: string }) => ({
			web: [
				{ url: "https://people.example/profile", title: "Profile", markdown: "Generic" },
				{
					url: "https://records.university.ac.uk/report.pdf",
					title: "Official report",
					markdown: "Official age table",
				},
			],
			images: [],
			news: [],
		}));
		const scrape = vi.fn(async () => ({ metadata: {}, markdown: "Official age table" }));
		const output = await researchFirecrawl(
			{ topic: "faculty age", queries: ['site:university.ac.uk "faculty" filetype:pdf'], maxSources: 1 },
			{ client: { search, scrape } as Client },
		);
		expect(search).toHaveBeenCalledWith(expect.objectContaining({ categories: ["pdf"] }), undefined);
		expect(output).toContain("https://records.university.ac.uk/report.pdf");
		expect(output).toContain("Official age table");
		expect(output).not.toContain("people.example");
	});

	it("does not apply the PDF category to generic report wording", async () => {
		const search = vi.fn(async (_request: { categories?: string[] }) => ({
			web: [{ url: "https://example.com/report", title: "Annual report page" }],
			images: [],
			news: [],
		}));
		await researchFirecrawl(
			{ topic: "annual report disclosure", queries: ["annual report disclosure", "records -filetype:pdf"] },
			{ client: { search, scrape: vi.fn(async () => ({ metadata: {}, markdown: "Report facts" })) } as Client },
		);
		expect(search).toHaveBeenCalledTimes(2);
		for (const [request] of search.mock.calls) expect(request.categories).toBeUndefined();
	});

	it("selects one source per registrable domain before ranked subdomain backfill", async () => {
		const scrape = vi.fn(async ({ url }: { url: string }) => ({ metadata: {}, markdown: `Evidence ${url}` }));
		const client = {
			search: vi.fn(async () => ({
				web: [
					{ url: "https://a.records.ac.uk/a", title: "A" },
					{ url: "https://b.records.ac.uk/b", title: "B" },
					{ url: "https://other.ac.uk/c", title: "C" },
				],
				images: [],
				news: [],
			})),
			scrape,
		} as Client;
		await researchFirecrawl({ topic: "topic", queries: ["topic"], maxSources: 2 }, { client });
		expect(scrape.mock.calls.map((call) => call[0].url)).toEqual([
			"https://a.records.ac.uk/a",
			"https://other.ac.uk/c",
		]);
	});

	it("serializes scrapes independently of concurrent searches", async () => {
		let activeScrapes = 0;
		let peakScrapes = 0;
		const scrape = vi.fn(async ({ url }: { url: string }) => {
			activeScrapes++;
			peakScrapes = Math.max(peakScrapes, activeScrapes);
			await Promise.resolve();
			activeScrapes--;
			return { metadata: {}, markdown: `Fetched ${url}` };
		});
		const client = {
			search: vi.fn(async () => ({
				web: [
					{ url: "https://one.example/a", title: "A" },
					{ url: "https://two.example/b", title: "B" },
					{ url: "https://three.example/c", title: "C" },
				],
				images: [],
				news: [],
			})),
			scrape,
		} as Client;
		await researchFirecrawl({ topic: "topic", queries: ["topic"], maxSources: 3 }, { client });
		expect(scrape).toHaveBeenCalledTimes(3);
		expect(peakScrapes).toBe(1);
	});

	it("supplies a deterministic as-of date and requires range-preserving temporal inference", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: 'Evidence calibration: direct [1]\nDirect evidence: "Reported age: 58." [1]\nThe source reported age 58 in January 2025; as of 2026-08-09, the justified range is 59–60 because the birthday is unknown [1].\n\nSources:\n[1] https://records.example/person',
				},
			],
		});
		const client = {
			search: vi.fn(async () => ({
				web: [{ url: "https://records.example/person", title: "Dated record" }],
				images: [],
				news: [],
			})),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Report date: 2025-01-15. Reported age: 58." })),
		} as Client;
		const output = await researchFirecrawl(
			{ topic: "current age", queries: ["official dated record"], maxFollowUpQueries: 0, asOfDate: "2026-08-09" },
			{ client, registry: registry(), researchModel: "test/cheap" },
		);
		const request = completeSimpleMock.mock.calls[0][1];
		expect(request.systemPrompt).toContain("derive the present-day value, duration, status, or justified range");
		expect(request.systemPrompt).toContain("Never collapse a range to an exact value");
		expect(request.messages[0].content[0].text).toContain("As-of date: 2026-08-09");
		expect(request.messages[0].content[0].text).toContain("Reported age: 58");
		expect(output).toContain("59–60");
	});

	it("supplies the same as-of date to automatic query planning", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({ stopReason: "stop", content: [{ type: "text", text: '["dated evidence"]' }] })
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: '{"sufficient":true,"candidate":"status","unresolved_constraints":[],"queries":[]}',
					},
				],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Dated status" [1]\nCurrent status [1].\n\nSources:\n[1] https://example.com/status',
					},
				],
			});
		const client = {
			search: vi.fn(async () => ({
				web: [{ url: "https://example.com/status", title: "Status" }],
				images: [],
				news: [],
			})),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Dated status" })),
		} as Client;
		await researchFirecrawl(
			{ topic: "current status", asOfDate: "2026-08-09" },
			{ client, registry: registry(), researchModel: "test/cheap" },
		);
		expect(completeSimpleMock.mock.calls[0][1].systemPrompt).toContain("Research date: 2026-08-09");
		expect(completeSimpleMock.mock.calls[2][1].messages[0].content[0].text).toContain("As-of date: 2026-08-09");
	});

	it("keeps an operator-free rung and at most one formal-record query from automatic planning", async () => {
		completeSimpleMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: '["site:records.example rare anchor", "filetype:pdf rare anchor", "-allintitle:archive rare anchor", "“rare anchor” “relation clue”"]',
					},
				],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Verified relation." [1]\nVerified [1].\n\nSources:\n[1] https://example.com/source',
					},
				],
			});
		const search = vi.fn(async (_request: { query: string }) => ({
			web: [{ url: "https://example.com/source", title: "Source" }],
			images: [],
			news: [],
		}));
		await researchFirecrawl(
			{ topic: "  rare   anchor relation  ", maxQueries: 4, maxFollowUpQueries: 0 },
			{
				client: { search, scrape: vi.fn(async () => ({ metadata: {}, markdown: "Verified relation." })) } as Client,
				registry: registry(),
				researchModel: "test/cheap",
			},
		);
		const searched = search.mock.calls.map((call) => call[0].query);
		expect(searched).not.toContain("rare anchor relation");
		expect(
			searched.filter((query) => /-?(?:site|filetype|inurl|allinurl|intitle|allintitle|related)\s*:/.test(query)),
		).toHaveLength(1);
		expect(searched).toContain('"rare anchor" relation clue');
		expect(searched.join(" ")).not.toMatch(/[“”]/);
	});

	it("de-operators an all-formal automatic plan and caps generated queries", async () => {
		const longAnchor = "x".repeat(600);
		completeSimpleMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: JSON.stringify([`-allinurl:records.example/path ${longAnchor}`]) }],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Verified." [1]\nVerified [1].\n\nSources:\n[1] https://example.com/source',
					},
				],
			});
		const search = vi.fn(async (_request: { query: string }) => ({
			web: [{ url: "https://example.com/source", title: "Source" }],
			images: [],
			news: [],
		}));
		await researchFirecrawl(
			{ topic: "long topic", maxFollowUpQueries: 0 },
			{
				client: { search, scrape: vi.fn(async () => ({ metadata: {}, markdown: "Verified." })) } as Client,
				registry: registry(),
				researchModel: "test/cheap",
			},
		);
		const generated = search.mock.calls[0][0].query;
		expect(generated.length).toBeLessThanOrEqual(500);
		expect(generated.length).toBeGreaterThan(400);
		expect(generated).not.toMatch(/allinurl\s*:/);
		expect(generated).toContain("records.example/path");
	});

	it("rejects oversized explicit queries before search", async () => {
		const explicit = `  literal   ${"z".repeat(510)}  `;
		const client = { search: vi.fn(), scrape: vi.fn() } as unknown as Client;
		await expect(
			researchFirecrawl({ topic: "topic", queries: [explicit], maxFollowUpQueries: 0 }, { client }),
		).rejects.toThrow("Research queries must be at most 500 characters.");
		expect(client.search).not.toHaveBeenCalled();
	});

	it("leaves valid explicit query quoting and whitespace exact", async () => {
		const explicit = '  “first phrase”   "second phrase"  ';
		const search = vi.fn(async (_request: { query: string }) => ({
			web: [{ url: "https://example.com/source", title: "Source" }],
			images: [],
			news: [],
		}));
		await researchFirecrawl(
			{ topic: "topic", queries: [explicit], maxFollowUpQueries: 0 },
			{ client: { search, scrape: vi.fn(async () => ({ metadata: {}, markdown: "Evidence" })) } as Client },
		);
		expect(search.mock.calls[0][0].query).toBe(explicit);
	});

	it("runs one bounded adaptive search round when initial evidence is insufficient", async () => {
		const traceEvents: FirecrawlResearchTraceEvent[] = [];
		completeSimpleMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: '{"sufficient":false,"candidate":"possible result","unresolved_constraints":["primary measurement"],"queries":["\\"formal benchmark\\" \\"measurement\\" filetype:pdf","duplicate ignored","third ignored"]}',
					},
				],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Official measured result." [1]\nThe formal record supplies the missing result [1].\n\nSources:\n[1] https://records.example.edu/benchmark.pdf',
					},
				],
			});
		const search = vi.fn(async ({ query }: { query: string }) =>
			query.includes("filetype:pdf")
				? {
						web: [{ url: "https://records.example.edu/benchmark.pdf", title: "Formal benchmark" }],
						images: [],
						news: [],
					}
				: {
						web: [{ url: "https://blog.example/overview", title: "Overview", description: "No primary result." }],
						images: [],
						news: [],
					},
		);
		const scrape = vi.fn(async ({ url }: { url: string }) => ({
			metadata: {},
			markdown: url.endsWith(".pdf") ? "Official measured result." : "General overview.",
		}));
		const output = await researchFirecrawl(
			{ topic: "benchmark outcome", queries: ["benchmark overview"], maxFollowUpQueries: 1, maxSources: 2 },
			{
				client: { search, scrape } as Client,
				registry: registry(),
				researchModel: "test/cheap",
				onTrace: (event) => traceEvents.push(event),
			},
		);

		expect(search).toHaveBeenCalledTimes(2);
		expect(search.mock.calls[1][0]).toEqual(expect.objectContaining({ categories: ["pdf"] }));
		expect(search.mock.calls[1][0].query).toBe('"formal benchmark" measurement filetype:pdf');
		expect(completeSimpleMock.mock.calls[0][1].messages[0].content[0].text).toContain("General overview");
		expect(scrape).toHaveBeenCalledWith(
			{ url: "https://records.example.edu/benchmark.pdf", formats: ["markdown"], onlyMainContent: true },
			undefined,
		);
		expect(output).toContain("missing result [1]");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(traceEvents).toContainEqual(
			expect.objectContaining({
				stage: "assessment",
				candidate: "possible result",
				unresolvedConstraints: ["primary measurement"],
			}),
		);
		expect(traceEvents.at(-1)).toEqual({ stage: "result", outcome: "synthesis" });
	});

	it("does not assess or search follow-ups when maxSources has no remaining capacity", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			stopReason: "stop",
			content: [
				{
					type: "text",
					text: 'Evidence calibration: direct [1]\nDirect evidence: "Complete evidence." [1]\nComplete [1].\n\nSources:\n[1] https://example.com/source',
				},
			],
		});
		const client = {
			search: vi.fn(async () => ({
				web: [{ url: "https://example.com/source", title: "Source" }],
				images: [],
				news: [],
			})),
			scrape: vi.fn(async () => ({ metadata: {}, markdown: "Complete evidence." })),
		} as Client;
		await researchFirecrawl(
			{ topic: "topic", queries: ["topic"], maxSources: 1, maxFollowUpQueries: 2 },
			{ client, registry: registry(), researchModel: "test/cheap" },
		);
		expect(client.search).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("recovers from zero initial results through the single adaptive round", async () => {
		const traceEvents: FirecrawlResearchTraceEvent[] = [];
		completeSimpleMock
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [{ type: "text", text: '["initial broad lookup"]' }],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: '{"sufficient":false,"candidate":null,"unresolved_constraints":["primary record"],"queries":["formal primary record filetype:pdf"]}',
					},
				],
			})
			.mockResolvedValueOnce({
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: 'Evidence calibration: direct [1]\nDirect evidence: "Recorded outcome: Delta." [1]\nThe recorded outcome is Delta [1].\n\nSources:\n[1] https://archive.example.edu/record.pdf',
					},
				],
			});
		const search = vi.fn(async ({ query }: { query: string }) =>
			query.includes("primary record")
				? {
						web: [{ url: "https://archive.example.edu/record.pdf", title: "Primary record" }],
						images: [],
						news: [],
					}
				: { web: [], images: [], news: [], warning: "no indexed matches", creditsUsed: 1 },
		);
		const scrape = vi.fn(async () => ({ metadata: {}, markdown: "Recorded outcome: Delta." }));
		const output = await researchFirecrawl(
			{ topic: "identify the recorded outcome", maxFollowUpQueries: 1 },
			{
				client: { search, scrape } as Client,
				registry: registry(),
				researchModel: "test/cheap",
				onTrace: (event) => traceEvents.push(event),
			},
		);

		expect(search).toHaveBeenCalledTimes(2);
		expect(scrape).toHaveBeenCalledTimes(1);
		expect(output).toContain("recorded outcome is Delta [1]");
		expect(traceEvents).toContainEqual({ stage: "selected-evidence", round: "initial", evidence: [] });
		expect(traceEvents).toContainEqual(
			expect.objectContaining({
				stage: "search",
				round: "initial",
				status: "success",
				results: [],
				warning: "no indexed matches",
				creditsUsed: 1,
			}),
		);
		expect(traceEvents).toContainEqual(
			expect.objectContaining({ stage: "assessment", queries: ["formal primary record filetype:pdf"] }),
		);
		expect(traceEvents).toContainEqual(
			expect.objectContaining({ stage: "search", round: "follow-up", query: "formal primary record filetype:pdf" }),
		);
	});

	it.each([
		["no model", {}, undefined],
		["adaptation disabled", { maxFollowUpQueries: 0 }, "test/cheap"],
	])("fails immediately on zero evidence with %s", async (_label, optionOverrides, researchModel) => {
		const client = {
			search: vi.fn(async () => ({ web: [], images: [], news: [] })),
			scrape: vi.fn(),
		} as Client;
		await expect(
			researchFirecrawl(
				{ topic: "missing evidence", queries: ["initial lookup"], ...optionOverrides },
				{ client, registry: registry(), researchModel },
			),
		).rejects.toThrow("Web research returned no usable evidence.");
		expect(client.search).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("propagates cancellation", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const client = { search: vi.fn(), scrape: vi.fn() } as unknown as Client;
		await expect(researchFirecrawl({ topic: "topic", signal: controller.signal }, { client })).rejects.toThrow(
			"cancelled",
		);
	});
});
