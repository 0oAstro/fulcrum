import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const defaultFulcrumDownloadBaseUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev";
const originalSkipVersionCheck = process.env.FULCRUM_SKIP_VERSION_CHECK;
const originalOffline = process.env.FULCRUM_OFFLINE;
const originalFulcrumDownloadBaseUrl = process.env.FULCRUM_DOWNLOAD_BASE_URL;
const originalFulcrumUpdateRepository = process.env.FULCRUM_UPDATE_REPOSITORY;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

beforeEach(() => {
	// Tests must not inherit the developer's offline/version-check shell flags.
	delete process.env.FULCRUM_SKIP_VERSION_CHECK;
	delete process.env.FULCRUM_OFFLINE;
	// Keep the manifest tests explicit; the Fulcrum package defaults to GitHub
	// Releases when no custom download base is configured.
	process.env.FULCRUM_DOWNLOAD_BASE_URL = defaultFulcrumDownloadBaseUrl;
});

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("FULCRUM_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("FULCRUM_OFFLINE", originalOffline);
	restoreEnv("FULCRUM_DOWNLOAD_BASE_URL", originalFulcrumDownloadBaseUrl);
	restoreEnv("FULCRUM_UPDATE_REPOSITORY", originalFulcrumUpdateRepository);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the Fulcrum release manifest with a Fulcrum user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultFulcrumDownloadBaseUrl}/latest.json`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^fulcrum\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta release manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "v1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.4-beta.123.1.1234567")).resolves.toBe("1.2.4-beta.124.1.abcdef0");
		expect(fetchMock).toHaveBeenCalledWith(`${defaultFulcrumDownloadBaseUrl}/beta.json`, expect.any(Object));
	});

	it("returns the active package and tarball install spec from the release manifest", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				package: "fulcrum",
				tarball: "releases/v1.2.4/fulcrum-1.2.4.tgz",
				version: "v1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			installSpec: `${defaultFulcrumDownloadBaseUrl}/releases/v1.2.4/fulcrum-1.2.4.tgz`,
			packageName: "fulcrum",
			version: "1.2.4",
		});
	});

	it("uses the configured GitHub beta release asset when no manifest base is set", async () => {
		delete process.env.FULCRUM_DOWNLOAD_BASE_URL;
		process.env.FULCRUM_UPDATE_REPOSITORY = "0oAstro/fulcrum";
		const fetchMock = vi.fn(async () =>
			Response.json({
				tag_name: "beta",
				assets: [
					{
						name: "fulcrum-1.2.4-beta.12.1.abcdef0.tgz",
						browser_download_url:
							"https://github.com/0oAstro/fulcrum/releases/download/beta/fulcrum-1.2.4-beta.12.1.abcdef0.tgz",
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3-beta.11.1.1234567")).resolves.toEqual({
			installSpec: "https://github.com/0oAstro/fulcrum/releases/download/beta/fulcrum-1.2.4-beta.12.1.abcdef0.tgz",
			packageName: "fulcrum",
			version: "1.2.4-beta.12.1.abcdef0",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/0oAstro/fulcrum/releases/tags/beta",
			expect.objectContaining({ headers: expect.objectContaining({ accept: "application/vnd.github+json" }) }),
		);
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.FULCRUM_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
