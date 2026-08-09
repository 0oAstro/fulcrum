import type { Component } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.js";

/** Empty footer that preserves the component contract used by interactive mode. */
export class FooterComponent implements Component {
	constructor(private footerData: ReadonlyFooterDataProvider) {
		void this.footerData;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// no-op while the footer is empty
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	render(_width: number): string[] {
		return [];
	}
}
