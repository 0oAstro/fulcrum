import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanFirecrawlMarkdown, extractFirecrawlContent } from "../src/core/firecrawl-content-extractor.js";
import type { ModelRegistry } from "../src/core/model-registry.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (original) => ({ ...(await original()), completeSimple: completeSimpleMock }));

function textModel(id: string, cost: number): Model<Api> {
	return {
		id,
		name: id,
		provider: id,
		api: "openai-completions",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

describe("Firecrawl content extraction", () => {
	beforeEach(() => completeSimpleMock.mockReset());

	it("uses the cheapest authenticated text model and forwards cancellation", async () => {
		const expensive = textModel("expensive", 5);
		const cheap = textModel("cheap", 0.1);
		const registry = {
			getAvailable: vi.fn(() => [expensive, cheap]),
			getApiKeyAndHeaders: vi.fn(async (model: Model<Api>) => ({ ok: true, apiKey: `key-${model.id}` })),
		} as unknown as ModelRegistry;
		completeSimpleMock.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: "Useful facts" }] });
		const signal = new AbortController().signal;
		const result = await extractFirecrawlContent({
			registry,
			url: "https://example.com",
			markdown: "page",
			instruction: "facts",
			maxOutput: 12000,
			signal,
		});
		expect(result).toBe("Useful facts");
		expect(completeSimpleMock.mock.calls[0][0]).toBe(cheap);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ apiKey: "key-cheap", signal });
	});

	it("returns undefined without an authenticated model", async () => {
		const registry = {
			getAvailable: vi.fn(() => []),
			getApiKeyAndHeaders: vi.fn(),
		} as unknown as ModelRegistry;
		await expect(
			extractFirecrawlContent({
				registry,
				url: "https://example.com",
				markdown: "page",
				instruction: "facts",
				maxOutput: 100,
			}),
		).resolves.toBeUndefined();
	});

	it("removes image assets, base64 payloads, and repeated Firecrawl lines", () => {
		const markdown = "# Page\n\n![hero](https://cdn.example/a.png)\nFact\nFact\ndata:image/png;base64,AAAA\n\n\nNext";
		expect(cleanFirecrawlMarkdown(markdown)).not.toContain("cdn.example");
		expect(cleanFirecrawlMarkdown(markdown)).not.toContain("base64");
		expect(cleanFirecrawlMarkdown(markdown).match(/Fact/g)).toHaveLength(1);
	});
});
