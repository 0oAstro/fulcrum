import { describe, expect, it, vi } from "vitest";
import {
	FirecrawlApiError,
	FirecrawlClient,
	FirecrawlTransportError,
	presentFirecrawlOpen,
	presentFirecrawlSearch,
} from "../src/core/firecrawl-client.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("FirecrawlClient", () => {
	it("calls the v2 search endpoint and parses source-specific results", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				success: true,
				data: {
					web: [{ url: "https://example.com", title: "Example", description: "Result" }],
					images: [{ url: "https://example.com/page", imageUrl: "https://example.com/image.png", position: 1 }],
					news: [{ url: "https://example.com/news", title: "News", date: "2026-08-09" }],
				},
				id: "search-id",
				creditsUsed: 2,
			}),
		);
		const signal = new AbortController().signal;
		const client = new FirecrawlClient({ apiKey: " fc-test ", fetch: fetchMock });

		const result = await client.search({ query: "fulcrum", limit: 3, sources: ["web", "images", "news"] }, signal);

		expect(result.web[0]).toMatchObject({ url: "https://example.com", title: "Example" });
		expect(result.images[0].imageUrl).toBe("https://example.com/image.png");
		expect(result.news[0].date).toBe("2026-08-09");
		expect(result.id).toBe("search-id");
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.firecrawl.dev/v2/search");
		expect(init?.headers).toEqual({ Authorization: "Bearer fc-test", "Content-Type": "application/json" });
		expect(init?.signal).toBe(signal);
		expect(JSON.parse(String(init?.body))).toEqual({
			query: "fulcrum",
			limit: 3,
			sources: ["web", "images", "news"],
		});
	});

	it("uses the scrape endpoint for scrape and open", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				jsonResponse({
					success: true,
					data: {
						markdown: "# Example",
						links: ["https://example.com/about"],
						metadata: { title: "Example", statusCode: 200 },
					},
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ success: true, data: { summary: "Example summary", metadata: {} } }));
		const client = new FirecrawlClient({ apiKey: "fc-test", fetch: fetchMock });

		const scraped = await client.scrape({ url: "https://example.com", formats: ["markdown", "links"] });
		const opened = await client.open({ url: "https://example.com", formats: ["summary"] });

		expect(scraped.markdown).toBe("# Example");
		expect(scraped.metadata.title).toBe("Example");
		expect(opened.summary).toBe("Example summary");
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			"https://api.firecrawl.dev/v2/scrape",
			"https://api.firecrawl.dev/v2/scrape",
		]);
	});

	it("calls the v2 map endpoint and parses links", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				success: true,
				links: [{ url: "https://example.com/docs", title: "Docs", description: "Documentation" }],
			}),
		);
		const client = new FirecrawlClient({ apiKey: "fc-test", fetch: fetchMock });

		const result = await client.map({ url: "https://example.com", search: "docs", sitemap: "include", limit: 25 });

		expect(result.links).toEqual([{ url: "https://example.com/docs", title: "Docs", description: "Documentation" }]);
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.firecrawl.dev/v2/map");
	});

	it("surfaces typed Firecrawl API errors", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ success: false, error: "Rate limit exceeded", code: "RATE_LIMIT" }, 429));
		const client = new FirecrawlClient({ apiKey: "fc-test", fetch: fetchMock });

		let error: unknown;
		try {
			await client.search({ query: "test" });
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(FirecrawlApiError);
		expect(error).toMatchObject({ message: "Rate limit exceeded", status: 429, code: "RATE_LIMIT" });
	});

	it("types application-level failures returned with HTTP 200", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ success: false, error: "Rejected", code: "BAD_REQUEST", statusCode: 422 }));
		const client = new FirecrawlClient({ apiKey: "fc-test", fetch: fetchMock });
		await expect(client.search({ query: "test" })).rejects.toMatchObject({
			name: "FirecrawlApiError",
			status: 422,
			code: "BAD_REQUEST",
		});
	});

	it("wraps fetch failures as typed transport errors but preserves abort", async () => {
		const transportClient = new FirecrawlClient({
			apiKey: "fc-test",
			fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("socket failed")),
		});
		await expect(transportClient.search({ query: "test" })).rejects.toBeInstanceOf(FirecrawlTransportError);

		const controller = new AbortController();
		controller.abort(new DOMException("Aborted", "AbortError"));
		const abortClient = new FirecrawlClient({
			apiKey: "fc-test",
			fetch: vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason),
		});
		await expect(abortClient.search({ query: "test" }, controller.signal)).rejects.toBe(controller.signal.reason);
	});

	it("presents compact allowlisted search and page content", () => {
		const search = presentFirecrawlSearch(
			{
				web: [{ url: "https://example.com", title: "Example", description: "A".repeat(100) }],
				images: [],
				news: [],
				id: "noise",
			},
			"example",
			80,
		);
		expect(search.length).toBeLessThanOrEqual(80);
		expect(search).toContain("output truncated");
		expect(search).not.toContain("noise");
		const opened = presentFirecrawlOpen(
			{ metadata: { title: "Example", extraNoise: "ignored" }, markdown: "Useful", html: "<nav>noise</nav>" },
			"https://example.com",
			["markdown"],
		);
		expect(opened).toContain("Page: Example");
		expect(opened).toContain("Useful");
		expect(opened).not.toContain("<nav>");
	});
});
