import { describe, expect, it, vi } from "vitest";
import type { FirecrawlClient } from "../src/core/firecrawl-client.js";
import { createWebsearchHostHandlers } from "../src/core/firecrawl-host.js";

type FirecrawlClientMethods = Pick<FirecrawlClient, "search" | "scrape" | "map">;

function clientMethods(): FirecrawlClientMethods {
	return {
		search: vi.fn(async () => ({ web: [{ url: "https://example.com", title: "Example" }], images: [], news: [] })),
		scrape: vi.fn(async () => ({ metadata: {}, markdown: "# Page" })),
		map: vi.fn(async () => ({ links: [{ url: "https://example.com/docs" }] })),
	};
}

describe("Firecrawl host handlers", () => {
	it("maps persistent Python module payloads to Firecrawl and forwards cancellation", async () => {
		const client = clientMethods();
		const createClient = vi.fn(() => client);
		const handlers = createWebsearchHostHandlers({ getApiKey: () => "fc-test", createClient });
		const signal = new AbortController().signal;

		await handlers["websearch.search"](
			{
				query: "fulcrum",
				limit: 4,
				include_domains: ["example.com"],
				recency: "week",
			},
			{ signal },
		);
		await handlers["websearch.research"]({ topic: "fulcrum", queries: ["fulcrum docs"], max_sources: 2 }, { signal });
		await handlers["websearch.open"](
			{ url: "https://example.com", formats: ["markdown"], only_main_content: true },
			{ signal },
		);
		await handlers["websearch.map"]({ url: "https://example.com", limit: 20 }, { signal });
		await handlers["websearch.fetch"]({ url: "https://example.com" }, { signal });

		expect(createClient).toHaveBeenCalledWith("fc-test");
		expect(client.search).toHaveBeenCalledWith(
			{
				query: "fulcrum",
				limit: 4,
				sources: ["web"],
				includeDomains: ["example.com"],
				excludeDomains: undefined,
				tbs: "qdr:w",
			},
			signal,
		);
		expect(client.scrape).toHaveBeenNthCalledWith(
			1,
			{ url: "https://example.com/", formats: ["markdown"], onlyMainContent: true },
			signal,
		);
		expect(client.scrape).toHaveBeenNthCalledWith(
			2,
			{ url: "https://example.com", formats: ["markdown"], onlyMainContent: true },
			signal,
		);
		expect(client.scrape).toHaveBeenNthCalledWith(
			3,
			{ url: "https://example.com", formats: ["markdown"], onlyMainContent: true },
			signal,
		);
		expect(client.map).toHaveBeenCalledWith({ url: "https://example.com", limit: 20 }, signal);
	});

	it("caps matrix research fan-out at the host boundary", async () => {
		const handlers = createWebsearchHostHandlers({ getApiKey: () => "fc-test", createClient: () => clientMethods() });
		await expect(handlers["websearch.research"]({ topic: "test", max_queries: 6 })).rejects.toThrow(
			"max_queries must be at most 5",
		);
		await expect(handlers["websearch.research"]({ topic: "test", results_per_query: 11 })).rejects.toThrow(
			"results_per_query must be at most 10",
		);
		await expect(handlers["websearch.research"]({ topic: "test", max_sources: 13 })).rejects.toThrow(
			"max_sources must be at most 12",
		);
		await expect(handlers["websearch.research"]({ topic: "test", follow_up_queries: 4 })).rejects.toThrow(
			"follow_up_queries must be at most 3",
		);
	});

	it("cleans browser fetch fallback output", async () => {
		const client = clientMethods();
		vi.mocked(client.scrape).mockResolvedValueOnce({
			metadata: {},
			markdown: "Fact\nFact\n![asset](https://example.com/image.png)\ndata:image/png;base64,AAAA",
		});
		const handlers = createWebsearchHostHandlers({ getApiKey: () => "fc-test", createClient: () => client });
		const result = await handlers["websearch.fetch"]({ url: "https://example.com" });
		expect(typeof result.text).toBe("string");
		const text = String(result.text);
		expect(text).not.toContain("image.png");
		expect(text).not.toContain("base64");
		expect(text.match(/Fact/g)).toHaveLength(1);
	});

	it("keeps the credential host-side and returns actionable setup guidance", async () => {
		const createClient = vi.fn(() => clientMethods());
		const handlers = createWebsearchHostHandlers({ getApiKey: () => undefined, createClient });

		await expect(handlers["websearch.search"]({ query: "test" })).rejects.toThrow(
			'Run /login, open MCP Connections, and choose "Firecrawl (web search and browser)"',
		);
		expect(createClient).not.toHaveBeenCalled();
	});

	it("rejects conflicting domain filters and invalid browser formats", async () => {
		const handlers = createWebsearchHostHandlers({
			getApiKey: () => "fc-test",
			createClient: () => clientMethods(),
		});

		await expect(
			handlers["websearch.search"]({
				query: "test",
				include_domains: ["example.com"],
				exclude_domains: ["invalid.example"],
			}),
		).rejects.toThrow("cannot be used together");
		await expect(
			handlers["websearch.open"]({ url: "https://example.com", formats: ["unsupported"] }),
		).rejects.toThrow("unsupported scrape format");
	});
});
