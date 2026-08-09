/**
 * Namespaced `_meta` payloads for fulcrum capabilities that ACP has no
 * native concept for (IPython cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a fulcrum-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every fulcrum `_meta` payload. */
export const FULCRUM_META_NAMESPACE = "dev.fulcrum.agent";

export interface FulcrumSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface FulcrumAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface FulcrumIpythonAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface FulcrumIpythonMeta {
	/** Media the cell loaded into context, as reported by the ipython tool. */
	attachments?: FulcrumIpythonAttachmentMeta[];
	/** Number of diffs the cell displayed. */
	diffCount?: number;
}

export interface FulcrumGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface FulcrumRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface FulcrumAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface FulcrumCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd fulcrum is actually running in, fixed at startup. */
	actual: string;
}

export interface FulcrumSessionMeta {
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: FulcrumCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
	heartbeatsChanged?: boolean;
	goal?: FulcrumGoalMeta;
	refinement?: FulcrumRefinementMeta;
	agentMessage?: FulcrumAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: FulcrumSubagentMeta[];
	autonomous?: FulcrumAutonomousMeta;
	ipython?: FulcrumIpythonMeta;
}

/** Wrap a fulcrum payload in its reverse-domain `_meta` envelope. */
export function fulcrumMeta(payload: FulcrumSessionMeta): Record<string, unknown> {
	return { [FULCRUM_META_NAMESPACE]: payload };
}
