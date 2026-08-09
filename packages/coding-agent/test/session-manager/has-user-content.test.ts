import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDiscardableSessionDraftFile, SessionManager } from "../../src/core/session-manager.js";
import { userMsg } from "../utilities.js";

describe("SessionManager.hasUserContent", () => {
	function withSession(run: (session: SessionManager) => void): void {
		const tempDir = mkdtempSync(join(tmpdir(), "has-user-content-"));
		try {
			run(SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions")));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}

	it("is false for a fresh session with only the default configuration entries", () => {
		withSession((session) => {
			// What createAgentSession writes for every new session.
			session.appendModelChange("anthropic", "claude-opus-4-8");
			session.appendThinkingLevelChange("off");
			session.appendServiceTierChange("default");
			expect(session.hasUserContent()).toBe(false);
		});
	});

	it("recognizes only validated bootstrap drafts as discardable files", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "discardable-session-draft-"));
		try {
			const session = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			session.appendModelChange("anthropic", "claude-opus-4-8");
			session.appendThinkingLevelChange("off");
			session.appendServiceTierChange("default");
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Draft fixture did not persist");
			expect(await isDiscardableSessionDraftFile(sessionFile)).toBe(true);

			session.appendSessionInfo("keep this draft");
			expect(await isDiscardableSessionDraftFile(sessionFile)).toBe(false);

			const configured = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			configured.appendModelChange("anthropic", "claude-opus-4-8");
			configured.appendThinkingLevelChange("off");
			configured.appendModelChange("openai", "gpt-5");
			const configuredFile = configured.getSessionFile();
			if (!configuredFile) throw new Error("Configured draft fixture did not persist");
			expect(await isDiscardableSessionDraftFile(configuredFile)).toBe(false);

			const noModel = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
			noModel.appendThinkingLevelChange("off");
			noModel.appendSessionState({ status: "active" });
			const noModelFile = noModel.getSessionFile();
			if (!noModelFile) throw new Error("No-model draft fixture did not persist");
			expect(await isDiscardableSessionDraftFile(noModelFile)).toBe(true);

			const malformedFile = join(tempDir, "sessions", "malformed.jsonl");
			writeFileSync(malformedFile, '{"type":"session"}\nnot json\n');
			expect(await isDiscardableSessionDraftFile(malformedFile)).toBe(false);

			const malformedBootstrapFile = join(tempDir, "sessions", "malformed-bootstrap.jsonl");
			writeFileSync(
				malformedBootstrapFile,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "draft",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: "/project",
				})}\n${JSON.stringify({
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					provider: "anthropic",
				})}\n`,
			);
			expect(await isDiscardableSessionDraftFile(malformedBootstrapFile)).toBe(false);

			const futureVersionFile = join(tempDir, "sessions", "future-version.jsonl");
			writeFileSync(
				futureVersionFile,
				`${JSON.stringify({
					type: "session",
					version: 4,
					id: "future-draft",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: "/project",
				})}\n`,
			);
			expect(await isDiscardableSessionDraftFile(futureVersionFile)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("is true once the user changes the model after creation", () => {
		withSession((session) => {
			session.appendModelChange("anthropic", "claude-opus-4-8");
			session.appendThinkingLevelChange("off");
			session.appendModelChange("openai", "gpt-5");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the user changes the thinking level after creation", () => {
		withSession((session) => {
			session.appendModelChange("anthropic", "claude-opus-4-8");
			session.appendThinkingLevelChange("off");
			session.appendThinkingLevelChange("high");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the user enables Fast mode after creation", () => {
		withSession((session) => {
			session.appendModelChange("openai-codex", "gpt-5.5");
			session.appendThinkingLevelChange("medium");
			session.appendServiceTierChange("default");
			session.appendServiceTierChange("priority");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is false for a fresh session created with no model available (thinking entry only)", () => {
		withSession((session) => {
			// createAgentSession skips the model_change when no model is configured,
			// leaving a lone leading thinking_level_change as the creation default.
			session.appendThinkingLevelChange("off");
			expect(session.hasUserContent()).toBe(false);
		});
	});

	it("is true once the user changes the thinking level on a no-model session", () => {
		withSession((session) => {
			session.appendThinkingLevelChange("off");
			session.appendThinkingLevelChange("high");
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true for a session with a message", () => {
		withSession((session) => {
			session.appendMessage(userMsg("hello"));
			expect(session.hasUserContent()).toBe(true);
		});
	});

	it("is true once the session is named", () => {
		withSession((session) => {
			session.appendModelChange("anthropic", "claude-opus-4-8");
			session.appendThinkingLevelChange("off");
			session.appendSessionInfo("my draft");
			expect(session.hasUserContent()).toBe(true);
		});
	});
});
