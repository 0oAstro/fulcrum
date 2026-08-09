import type { KeyId } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { Extension, ExtensionRuntime, ExtensionShortcut } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionManager } from "../src/core/session-manager.js";

function createRunner(keys: KeyId[]): ExtensionRunner {
	const shortcuts = new Map<KeyId, ExtensionShortcut>();
	for (const key of keys) {
		shortcuts.set(key, {
			shortcut: key,
			extensionPath: "test-extension.ts",
			handler: async () => {},
		});
	}

	const extension = { path: "test-extension.ts", shortcuts } as Extension;
	return new ExtensionRunner([extension], {} as ExtensionRuntime, "/tmp", {} as SessionManager, {} as ModelRegistry);
}

describe("extension shortcut reservations", () => {
	it("reserves model and thinking cycle defaults across modifier orderings", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const shortcuts = createRunner(["ctrl+p", "shift+ctrl+p", "shift+tab"]).getShortcuts(
				new KeybindingsManager().getEffectiveConfig(),
			);

			expect(shortcuts.size).toBe(0);
			expect(warnSpy).toHaveBeenCalledTimes(3);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("reserves rebound model and thinking cycle shortcuts from extensions", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const keybindings = {
				...new KeybindingsManager().getEffectiveConfig(),
				"app.model.cycleForward": "ctrl+x" as KeyId,
				"app.model.cycleBackward": "ctrl+shift+y" as KeyId,
				"app.thinking.cycle": "ctrl+g" as KeyId,
			};
			const shortcuts = createRunner(["ctrl+x", "shift+ctrl+y", "ctrl+g"]).getShortcuts(keybindings);

			expect(shortcuts.size).toBe(0);
			expect(warnSpy).toHaveBeenCalledTimes(3);
		} finally {
			warnSpy.mockRestore();
		}
	});
});
