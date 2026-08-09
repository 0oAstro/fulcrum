import {
	FirecrawlClient,
	type FirecrawlMapOptions,
	type FirecrawlScrapeFormat,
	type FirecrawlScrapeOptions,
	type FirecrawlSearchOptions,
	presentFirecrawlOpen,
	presentFirecrawlSearch,
} from "./firecrawl-client.js";
import { cleanFirecrawlMarkdown, extractFirecrawlContent } from "./firecrawl-content-extractor.js";
import { researchFirecrawl } from "./firecrawl-research.js";
import type { HostRequestHandlers } from "./kernel/index.js";
import type { ModelRegistry } from "./model-registry.js";

const RECENCY_TO_TBS = {
	hour: "qdr:h",
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
} as const;

const SCRAPE_FORMATS = new Set<FirecrawlScrapeFormat>([
	"markdown",
	"summary",
	"html",
	"rawHtml",
	"links",
	"images",
	"screenshot",
	"branding",
	"audio",
	"highlights",
]);

type FirecrawlClientMethods = Pick<FirecrawlClient, "search" | "scrape" | "map">;

export interface WebsearchHostOptions {
	getApiKey: () => string | undefined;
	createClient?: (apiKey: string) => FirecrawlClientMethods;
	modelRegistry?: ModelRegistry;
	researchModel?: string;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value.trim();
}

function optionalInteger(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 1) {
		throw new Error(`${key} must be a positive integer`);
	}
	return value as number;
}

function optionalBoundedInteger(payload: Record<string, unknown>, key: string, maximum: number): number | undefined {
	const value = optionalInteger(payload, key);
	if (value !== undefined && value > maximum) throw new Error(`${key} must be at most ${maximum}`);
	return value;
}

function optionalNonNegativeBoundedInteger(
	payload: Record<string, unknown>,
	key: string,
	maximum: number,
): number | undefined {
	const value = payload[key];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${key} must be a non-negative integer`);
	if ((value as number) > maximum) throw new Error(`${key} must be at most ${maximum}`);
	return value as number;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const value = payload[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new Error(`${key} must be a boolean`);
	}
	return value;
}

function optionalStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	const value = payload[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
		throw new Error(`${key} must be an array of non-empty strings`);
	}
	return value.map((item) => item.trim());
}

function searchOptions(payload: Record<string, unknown>): FirecrawlSearchOptions {
	const includeDomains = optionalStringArray(payload, "include_domains");
	const excludeDomains = optionalStringArray(payload, "exclude_domains");
	if (includeDomains && excludeDomains) {
		throw new Error("include_domains and exclude_domains cannot be used together");
	}

	let tbs: string | undefined;
	const recency = payload.recency;
	if (recency !== undefined) {
		if (typeof recency !== "string" || !(recency in RECENCY_TO_TBS)) {
			throw new Error("recency must be one of: hour, day, week, month, year");
		}
		tbs = RECENCY_TO_TBS[recency as keyof typeof RECENCY_TO_TBS];
	}

	return {
		query: requiredString(payload, "query"),
		limit: optionalInteger(payload, "limit"),
		sources: ["web"],
		includeDomains,
		excludeDomains,
		tbs,
	};
}

function scrapeOptions(payload: Record<string, unknown>): FirecrawlScrapeOptions {
	const rawFormats = optionalStringArray(payload, "formats");
	const formats = rawFormats?.map((format) => {
		if (!SCRAPE_FORMATS.has(format as FirecrawlScrapeFormat)) {
			throw new Error(`unsupported scrape format: ${format}`);
		}
		return format as FirecrawlScrapeFormat;
	});
	return {
		url: requiredString(payload, "url"),
		formats,
		onlyMainContent: optionalBoolean(payload, "only_main_content"),
	};
}

function mapOptions(payload: Record<string, unknown>): FirecrawlMapOptions {
	return {
		url: requiredString(payload, "url"),
		limit: optionalInteger(payload, "limit"),
	};
}

function configuredClient(options: WebsearchHostOptions): FirecrawlClientMethods {
	const apiKey = options.getApiKey()?.trim();
	if (!apiKey) {
		throw new Error(
			'Firecrawl is not configured. Run /login, open MCP Connections, and choose "Firecrawl (web search and browser)".',
		);
	}
	return options.createClient?.(apiKey) ?? new FirecrawlClient({ apiKey });
}

export function createWebsearchHostHandlers(options: WebsearchHostOptions): HostRequestHandlers {
	return {
		"websearch.search": async (payload, context) => {
			const request = searchOptions(payload);
			const result = await configuredClient(options).search(request, context?.signal);
			return { text: presentFirecrawlSearch(result, request.query, optionalInteger(payload, "max_output")) };
		},
		"websearch.research": async (payload, context) => {
			const topic = requiredString(payload, "topic");
			const includeDomains = optionalStringArray(payload, "include_domains");
			const excludeDomains = optionalStringArray(payload, "exclude_domains");
			if (includeDomains && excludeDomains)
				throw new Error("include_domains and exclude_domains cannot be used together");
			const recency = payload.recency;
			if (recency !== undefined && (typeof recency !== "string" || !(recency in RECENCY_TO_TBS))) {
				throw new Error("recency must be one of: hour, day, week, month, year");
			}
			const instruction = payload.instruction;
			if (instruction !== undefined && typeof instruction !== "string")
				throw new Error("instruction must be a string");
			return {
				text: await researchFirecrawl(
					{
						topic,
						queries: optionalStringArray(payload, "queries"),
						maxQueries: optionalBoundedInteger(payload, "max_queries", 5),
						maxFollowUpQueries: optionalNonNegativeBoundedInteger(payload, "follow_up_queries", 3),
						resultsPerQuery: optionalBoundedInteger(payload, "results_per_query", 10),
						maxSources: optionalBoundedInteger(payload, "max_sources", 12),
						instruction: typeof instruction === "string" ? instruction.trim() || undefined : undefined,
						includeDomains,
						excludeDomains,
						tbs: typeof recency === "string" ? RECENCY_TO_TBS[recency as keyof typeof RECENCY_TO_TBS] : undefined,
						signal: context?.signal,
					},
					{
						client: configuredClient(options),
						registry: options.modelRegistry,
						researchModel: options.researchModel,
					},
				),
			};
		},
		"websearch.open": async (payload, context) => {
			const request = scrapeOptions(payload);
			const result = await configuredClient(options).scrape(request, context?.signal);
			return {
				text: presentFirecrawlOpen(
					result,
					request.url,
					request.formats ?? ["markdown"],
					optionalInteger(payload, "max_output"),
				),
			};
		},
		"websearch.fetch": async (payload, context) => {
			const url = requiredString(payload, "url");
			const instruction =
				typeof payload.instruction === "string" && payload.instruction.trim()
					? payload.instruction.trim()
					: "Extract the useful page content.";
			const maxOutput = optionalInteger(payload, "max_output") ?? 12000;
			const result = await configuredClient(options).scrape(
				{ url, formats: ["markdown"], onlyMainContent: true },
				context?.signal,
			);
			const cleanedResult = {
				...result,
				markdown: result.markdown ? cleanFirecrawlMarkdown(result.markdown) : undefined,
			};
			const fallback = presentFirecrawlOpen(cleanedResult, url, ["markdown"], maxOutput);
			if (!options.modelRegistry || !result.markdown) return { text: fallback };
			const extracted = await extractFirecrawlContent({
				registry: options.modelRegistry,
				url,
				markdown: result.markdown,
				instruction,
				maxOutput,
				signal: context?.signal,
			});
			return { text: extracted ?? fallback };
		},
		"websearch.map": async (payload, context) => ({
			...(await configuredClient(options).map(mapOptions(payload), context?.signal)),
		}),
	};
}
