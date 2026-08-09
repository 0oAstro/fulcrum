export const FIRECRAWL_V2_BASE_URL = "https://api.firecrawl.dev/v2";

export type FirecrawlSearchSource = "web" | "images" | "news";
export type FirecrawlSearchCategory = "github" | "research" | "pdf";

export interface FirecrawlLocation {
	country?: string;
	languages?: string[];
}

export interface FirecrawlSearchOptions {
	query: string;
	limit?: number;
	sources?: FirecrawlSearchSource[];
	categories?: FirecrawlSearchCategory[];
	includeDomains?: string[];
	excludeDomains?: string[];
	tbs?: string;
	location?: string;
	country?: string;
	timeout?: number;
	ignoreInvalidURLs?: boolean;
}

export interface FirecrawlWebResult {
	url: string;
	title?: string;
	description?: string;
	markdown?: string;
	category?: string;
}

export interface FirecrawlImageResult {
	url: string;
	imageUrl: string;
	title?: string;
	imageWidth?: number;
	imageHeight?: number;
	position?: number;
}

export interface FirecrawlNewsResult {
	url: string;
	title?: string;
	snippet?: string;
	date?: string;
	imageUrl?: string;
	position?: number;
	markdown?: string;
}

export interface FirecrawlSearchResult {
	web: FirecrawlWebResult[];
	images: FirecrawlImageResult[];
	news: FirecrawlNewsResult[];
	warning?: string;
	id?: string;
	creditsUsed?: number;
}

export type FirecrawlScrapeFormat =
	| "markdown"
	| "summary"
	| "html"
	| "rawHtml"
	| "links"
	| "images"
	| "screenshot"
	| "branding"
	| "audio"
	| "highlights";

export interface FirecrawlScrapeOptions {
	url: string;
	formats?: FirecrawlScrapeFormat[];
	onlyMainContent?: boolean;
	onlyCleanContent?: boolean;
	includeTags?: string[];
	excludeTags?: string[];
	maxAge?: number;
	minAge?: number;
	headers?: Record<string, string>;
	waitFor?: number;
	mobile?: boolean;
	skipTlsVerification?: boolean;
	timeout?: number;
	removeBase64Images?: boolean;
	blockAds?: boolean;
	proxy?: "basic" | "enhanced" | "auto";
	storeInCache?: boolean;
	lockdown?: boolean;
	zeroDataRetention?: boolean;
	location?: FirecrawlLocation;
}

export interface FirecrawlScrapeMetadata {
	title?: string;
	description?: string;
	language?: string;
	sourceURL?: string;
	url?: string;
	statusCode?: number;
	contentType?: string;
	error?: string;
	scrapeId?: string;
	[key: string]: unknown;
}

export interface FirecrawlScrapeResult {
	markdown?: string;
	summary?: string;
	html?: string;
	rawHtml?: string;
	screenshot?: string;
	audio?: string;
	highlights?: string[];
	links?: string[];
	images?: string[];
	metadata: FirecrawlScrapeMetadata;
	warning?: string;
}

export interface FirecrawlMapOptions {
	url: string;
	search?: string;
	sitemap?: "skip" | "include" | "only";
	includeSubdomains?: boolean;
	ignoreQueryParameters?: boolean;
	ignoreCache?: boolean;
	limit?: number;
	location?: FirecrawlLocation;
	timeout?: number;
}

export interface FirecrawlMapLink {
	url: string;
	title?: string;
	description?: string;
}

export interface FirecrawlMapResult {
	links: FirecrawlMapLink[];
}

export const DEFAULT_FIRECRAWL_SEARCH_MAX_OUTPUT = 8192;
export const DEFAULT_FIRECRAWL_OPEN_MAX_OUTPUT = 20000;

export function truncateFirecrawlOutput(output: string, maxOutput: number): string {
	if (output.length <= maxOutput) return output;
	const marker = `\n... [output truncated, ${output.length} chars total] ...\n`;
	const half = Math.max(0, Math.floor((maxOutput - marker.length) / 2));
	return `${output.slice(0, half)}${marker}${output.slice(-half)}`.slice(0, maxOutput);
}

export function presentFirecrawlSearch(
	result: FirecrawlSearchResult,
	query: string,
	maxOutput = DEFAULT_FIRECRAWL_SEARCH_MAX_OUTPUT,
): string {
	const sections = result.web.map((item, index) => {
		const lines = [`Result ${index}: ${item.title?.trim() || "Untitled"}`, `URL: ${item.url}`];
		if (item.description?.trim()) lines.push(item.description.trim());
		if (item.markdown?.trim()) lines.push(item.markdown.trim());
		return lines.join("\n");
	});
	const body = sections.length > 0 ? sections.join("\n\n---\n\n") : `No results returned for query: ${query}`;
	return truncateFirecrawlOutput(`Results for query "${query}":\n\n${body}`, maxOutput);
}

export function presentFirecrawlOpen(
	result: FirecrawlScrapeResult,
	url: string,
	formats: readonly FirecrawlScrapeFormat[] = ["markdown"],
	maxOutput = DEFAULT_FIRECRAWL_OPEN_MAX_OUTPUT,
): string {
	const lines = [result.metadata.title ? `Page: ${result.metadata.title}` : undefined, `URL: ${url}`].filter(
		(value): value is string => value !== undefined,
	);
	for (const format of formats) {
		const value = result[format as keyof FirecrawlScrapeResult];
		if (typeof value === "string" && value.trim()) lines.push(value.trim());
		else if (Array.isArray(value) && value.length > 0) lines.push(value.join("\n"));
	}
	return truncateFirecrawlOutput(lines.join("\n\n"), maxOutput);
}

export interface FirecrawlClientOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}

export class FirecrawlApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "FirecrawlApiError";
		this.status = status;
		this.code = code;
	}
}

export class FirecrawlTransportError extends Error {
	constructor(message = "Firecrawl transport request failed.") {
		super(message);
		this.name = "FirecrawlTransportError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Firecrawl returned an invalid ${label} response.`);
	return value;
}

function requireSuccess(payload: unknown, label: string): Record<string, unknown> {
	const record = requireRecord(payload, label);
	if (record.success !== true) {
		throw new FirecrawlApiError(
			stringValue(record.error) ?? `Firecrawl ${label} failed.`,
			numberValue(record.statusCode) ?? 200,
			stringValue(record.code),
		);
	}
	return record;
}

function parseWebResults(value: unknown): FirecrawlWebResult[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.url !== "string") return [];
		return [
			{
				url: item.url,
				title: stringValue(item.title),
				description: stringValue(item.description),
				markdown: stringValue(item.markdown),
				category: stringValue(item.category),
			},
		];
	});
}

function parseImageResults(value: unknown): FirecrawlImageResult[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.url !== "string" || typeof item.imageUrl !== "string") return [];
		return [
			{
				url: item.url,
				imageUrl: item.imageUrl,
				title: stringValue(item.title),
				imageWidth: numberValue(item.imageWidth),
				imageHeight: numberValue(item.imageHeight),
				position: numberValue(item.position),
			},
		];
	});
}

function parseNewsResults(value: unknown): FirecrawlNewsResult[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.url !== "string") return [];
		return [
			{
				url: item.url,
				title: stringValue(item.title),
				snippet: stringValue(item.snippet),
				date: stringValue(item.date),
				imageUrl: stringValue(item.imageUrl),
				position: numberValue(item.position),
				markdown: stringValue(item.markdown),
			},
		];
	});
}

function parseSearchResponse(payload: unknown): FirecrawlSearchResult {
	const response = requireSuccess(payload, "search");
	const data = requireRecord(response.data, "search data");
	return {
		web: parseWebResults(data.web),
		images: parseImageResults(data.images),
		news: parseNewsResults(data.news),
		warning: stringValue(response.warning),
		id: stringValue(response.id),
		creditsUsed: numberValue(response.creditsUsed),
	};
}

function parseScrapeResponse(payload: unknown): FirecrawlScrapeResult {
	const response = requireSuccess(payload, "scrape");
	const data = requireRecord(response.data, "scrape data");
	const metadata = isRecord(data.metadata) ? data.metadata : {};
	return {
		markdown: stringValue(data.markdown),
		summary: stringValue(data.summary),
		html: stringValue(data.html),
		rawHtml: stringValue(data.rawHtml),
		screenshot: stringValue(data.screenshot),
		audio: stringValue(data.audio),
		highlights: stringArray(data.highlights),
		links: stringArray(data.links),
		images: stringArray(data.images),
		metadata,
		warning: stringValue(data.warning),
	};
}

function parseMapResponse(payload: unknown): FirecrawlMapResult {
	const response = requireSuccess(payload, "map");
	const links: FirecrawlMapLink[] = [];
	if (Array.isArray(response.links)) {
		for (const item of response.links) {
			if (!isRecord(item) || typeof item.url !== "string") continue;
			links.push({
				url: item.url,
				title: stringValue(item.title),
				description: stringValue(item.description),
			});
		}
	}
	return { links };
}

export class FirecrawlClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(options: FirecrawlClientOptions) {
		if (!options.apiKey.trim()) throw new Error("Firecrawl API key is required.");
		this.apiKey = options.apiKey.trim();
		this.baseUrl = (options.baseUrl ?? FIRECRAWL_V2_BASE_URL).replace(/\/$/, "");
		this.fetchImpl = options.fetch ?? globalThis.fetch;
	}

	async search(options: FirecrawlSearchOptions, signal?: AbortSignal): Promise<FirecrawlSearchResult> {
		return parseSearchResponse(await this.post("search", options, signal));
	}

	async scrape(options: FirecrawlScrapeOptions, signal?: AbortSignal): Promise<FirecrawlScrapeResult> {
		return parseScrapeResponse(await this.post("scrape", options, signal));
	}

	async open(options: FirecrawlScrapeOptions, signal?: AbortSignal): Promise<FirecrawlScrapeResult> {
		return this.scrape(options, signal);
	}

	async map(options: FirecrawlMapOptions, signal?: AbortSignal): Promise<FirecrawlMapResult> {
		return parseMapResponse(await this.post("map", options, signal));
	}

	private async post(endpoint: string, body: object, signal?: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/${endpoint}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
			throw new FirecrawlTransportError();
		}
		if (!response.ok) {
			const payload = await this.readJson(response);
			const message = isRecord(payload) ? stringValue(payload.error) : undefined;
			const code = isRecord(payload) ? stringValue(payload.code) : undefined;
			throw new FirecrawlApiError(
				message ?? `Firecrawl request failed with HTTP ${response.status}.`,
				response.status,
				code,
			);
		}
		return this.readJson(response);
	}

	private async readJson(response: Response): Promise<unknown> {
		try {
			return await response.json();
		} catch {
			throw new FirecrawlApiError("Firecrawl returned a non-JSON response.", response.status);
		}
	}
}
