import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { APP_NAME } from "../config.js";
import type { AgentSession } from "../core/agent-session.js";
import { AuthStorage } from "../core/auth-storage.js";
import type { ToolDefinition } from "../core/extensions/types.js";
import { ModelRegistry } from "../core/model-registry.js";
import { DefaultResourceLoader } from "../core/resource-loader.js";
import { createAgentSession } from "../core/sdk.js";
import { SessionManager } from "../core/session-manager.js";
import { SettingsManager } from "../core/settings-manager.js";
import {
	isBuiltinSlashCommandName,
	parseSessionSlashCommand,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../core/slash-commands.js";
import type { WhatsAppGatewayConfig } from "./config.js";
import {
	type GatewayConversationProcessor,
	type GatewayInboundMessage,
	type GatewayMediaKind,
	shouldRotateConversation,
} from "./conversation-coordinator.js";

export interface WhatsAppOutboundMedia {
	chatId: string;
	path: string;
	kind: GatewayMediaKind;
	caption?: string;
	mimeType?: string;
}

export interface WhatsAppAgentOutbound {
	sendMedia(media: WhatsAppOutboundMedia): Promise<void>;
}

interface PersistedChatState {
	sessionFile: string;
	startedAt: string;
	lastActivity: string;
	model?: string;
}

interface PersistedGatewayState {
	version: 1;
	chats: Record<string, PersistedChatState>;
	nextModel: number;
}

interface LiveChat {
	session: AgentSession;
	sessionManager: SessionManager;
	startedAt: Date;
	lastActivity: Date;
	model?: string;
}

const SEND_MEDIA_PARAMETERS = Type.Object({
	path: Type.String({ description: "Absolute or working-directory-relative path to the media file" }),
	kind: Type.Union([
		Type.Literal("image"),
		Type.Literal("audio"),
		Type.Literal("voice"),
		Type.Literal("video"),
		Type.Literal("gif"),
		Type.Literal("document"),
	]),
	caption: Type.Optional(Type.String()),
	mimeType: Type.Optional(Type.String()),
});

const WHATSAPP_SYSTEM_PROMPT = `You are replying through a personal WhatsApp account.
- Treat the latest user message as the current request. If it conflicts with older context, follow the latest message.
- Prioritize attached media in the latest message before older chat context. Inspect downloaded files when useful.
- Use remembered user preferences and durable context quietly. When the user explicitly gives a stable preference, preserve it through the installed memory or refinement facilities when appropriate.
- Keep replies concise and natural for WhatsApp. Use plain text unless structure materially improves clarity.
- Do not expose internal agent, provider, tool, or session mechanics.
- Use whatsapp_send_media for outbound images, documents, audio, voice notes, video, or GIF-style video. Do not claim media was sent unless the tool succeeds.
- For web research, use the built-in Firecrawl-backed capability.
- Proactive follow-ups should be specific, useful, and time-sensitive. Do not send generic engagement prompts or fabricate monitoring results.`;

const TERMINAL_ONLY_COMMANDS = new Set([
	"settings",
	"model",
	"scoped-models",
	"export",
	"import",
	"share",
	"copy",
	"btw",
	"logs",
	"changelog",
	"update",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"login",
	"logout",
	"mcp",
	"rlm-max-depth",
	"heartbeat",
	"heartbeats",
	"fullscreen",
	"quit",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPersistedState(path: string): PersistedGatewayState {
	if (!existsSync(path)) return { version: 1, chats: {}, nextModel: 0 };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed.chats)) return { version: 1, chats: {}, nextModel: 0 };
		const chats: Record<string, PersistedChatState> = {};
		for (const [chatId, value] of Object.entries(parsed.chats)) {
			if (
				isRecord(value) &&
				typeof value.sessionFile === "string" &&
				typeof value.startedAt === "string" &&
				typeof value.lastActivity === "string"
			) {
				chats[chatId] = {
					sessionFile: value.sessionFile,
					startedAt: value.startedAt,
					lastActivity: value.lastActivity,
					model: typeof value.model === "string" ? value.model : undefined,
				};
			}
		}
		return {
			version: 1,
			chats,
			nextModel: typeof parsed.nextModel === "number" && parsed.nextModel >= 0 ? parsed.nextModel : 0,
		};
	} catch {
		return { version: 1, chats: {}, nextModel: 0 };
	}
}

function assistantText(message: AgentMessage): string | undefined {
	if (message.role !== "assistant") return undefined;
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => {
			return isRecord(block) && block.type === "text" && typeof block.text === "string";
		})
		.map((block) => block.text)
		.join("")
		.trim();
	return text || undefined;
}

function formatMessagePrompt(message: GatewayInboundMessage): string {
	const media = message.media.length
		? `<attached_media>\n${message.media
				.map(
					(item) =>
						`- kind=${item.kind} mime=${item.mimeType} path=${JSON.stringify(item.path)}${item.fileName ? ` filename=${JSON.stringify(item.fileName)}` : ""}`,
				)
				.join("\n")}\n</attached_media>\n`
		: "";
	return `<whatsapp_message sentAt=${JSON.stringify(message.sentAt.toISOString())}>\n${media}<text>\n${message.text || "[media message]"}\n</text>\n</whatsapp_message>`;
}

function imageAttachments(message: GatewayInboundMessage): ImageContent[] {
	return message.media
		.filter((media) => media.kind === "image" && media.data)
		.map((media) => ({ type: "image", data: media.data!, mimeType: media.mimeType }));
}

function validThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

export class WhatsAppAgentConversationProcessor implements GatewayConversationProcessor {
	private readonly liveChats = new Map<string, LiveChat>();
	private readonly statePath: string;
	private readonly sessionsDir: string;
	private readonly state: PersistedGatewayState;

	constructor(
		private readonly config: WhatsAppGatewayConfig,
		private readonly outbound: WhatsAppAgentOutbound,
		private readonly agentDir: string,
	) {
		this.statePath = join(config.dataDir, "conversations.json");
		this.sessionsDir = join(config.dataDir, "sessions");
		this.state = readPersistedState(this.statePath);
		mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
	}

	interrupt(chatId: string): void {
		this.liveChats.get(chatId)?.session.requestAbort();
	}

	async dispose(): Promise<void> {
		const chats = [...this.liveChats.values()];
		this.liveChats.clear();
		for (const chat of chats) chat.session.requestAbort();
		await Promise.allSettled(chats.map((chat) => chat.session.disposeAsync()));
	}

	async reset(chatId: string): Promise<void> {
		const live = this.liveChats.get(chatId);
		if (live) {
			live.session.requestAbort();
			await live.session.disposeAsync();
			this.liveChats.delete(chatId);
		}
		delete this.state.chats[chatId];
		this.persistState();
	}

	async process(message: GatewayInboundMessage): Promise<string | undefined> {
		let parsed = parseSlashCommand(message.text.trim());
		let commandName = parsed ? resolveBuiltinSlashCommandName(parsed.name) : undefined;
		if (commandName === "new") {
			await this.reset(message.chatId);
			if (!parsed?.args) return "Started a new conversation.";
			message = { ...message, text: parsed.args };
			parsed = parseSlashCommand(message.text.trim());
			commandName = parsed ? resolveBuiltinSlashCommandName(parsed.name) : undefined;
		}

		let chat = await this.getChat(message.chatId);
		const now = new Date();
		if (shouldRotateConversation(chat.lastActivity, chat.startedAt, now, this.config.rotation)) {
			await this.reset(message.chatId);
			chat = await this.getChat(message.chatId);
		}

		const localCommandResponse = await this.handleLocalCommand(chat, parsed, commandName);
		if (localCommandResponse !== undefined) {
			chat.lastActivity = message.sentAt;
			this.updatePersistedChat(message.chatId, chat);
			return localCommandResponse;
		}

		let response: string | undefined;
		const unsubscribe = chat.session.subscribe((event) => {
			if (event.type === "message_end") {
				response = assistantText(event.message);
			}
		});
		try {
			await chat.session.prompt(
				parsed && message.media.length === 0 ? message.text.trim() : formatMessagePrompt(message),
				{
					images: imageAttachments(message),
					source: "interactive",
				},
			);
		} finally {
			unsubscribe();
			chat.lastActivity = message.sentAt;
			this.updatePersistedChat(message.chatId, chat);
		}
		if (!response && parseSessionSlashCommand(message.text.trim())) {
			return `/${parseSessionSlashCommand(message.text.trim())!.name} completed.`;
		}
		return response;
	}

	private async handleLocalCommand(
		chat: LiveChat,
		parsed: ReturnType<typeof parseSlashCommand>,
		commandName: string | undefined,
	): Promise<string | undefined> {
		if (!parsed || !commandName) return undefined;
		if (commandName === "name") {
			if (parsed.args) chat.session.setSessionName(parsed.args);
			return chat.session.sessionName
				? `Conversation name: ${chat.session.sessionName}`
				: "This conversation has no name.";
		}
		if (commandName === "session") {
			const model = chat.session.model;
			return `Session ${chat.session.sessionId}${model ? `, model ${model.provider}/${model.id}` : ""}.`;
		}
		if (commandName === "context") {
			const usage = chat.session.getContextUsage();
			if (!usage) return "Context usage is unavailable until the model has responded.";
			return `Context: ${usage.tokens ?? "unknown"}/${usage.contextWindow} tokens${usage.percent === null ? "" : ` (${usage.percent.toFixed(1)}%)`}.`;
		}
		if (commandName === "system-prompt") {
			return chat.session.systemPrompt.slice(0, 6000);
		}
		if (commandName === "reload") {
			await chat.session.reload();
			return "Reloaded skills, prompts, extensions, and settings.";
		}
		if (commandName === "effort") {
			if (!parsed.args) return `Reasoning effort: ${chat.session.thinkingLevel}.`;
			if (!validThinkingLevel(parsed.args)) {
				return "Usage: /effort off|minimal|low|medium|high|xhigh|max";
			}
			chat.session.setThinkingLevel(parsed.args);
			return `Reasoning effort: ${chat.session.thinkingLevel}.`;
		}
		if (
			TERMINAL_ONLY_COMMANDS.has(commandName) ||
			(isBuiltinSlashCommandName(parsed.name) && !parseSessionSlashCommand(`/${commandName} ${parsed.args}`.trim()))
		) {
			return `/${parsed.name} is not available over WhatsApp. Run ${APP_NAME} in a terminal to use it.`;
		}
		return undefined;
	}

	private async getChat(chatId: string): Promise<LiveChat> {
		const live = this.liveChats.get(chatId);
		if (live) return live;
		const persisted = this.state.chats[chatId];
		const sessionManager =
			persisted && existsSync(persisted.sessionFile)
				? SessionManager.open(persisted.sessionFile, this.sessionsDir, this.config.cwd)
				: SessionManager.create(this.config.cwd, this.sessionsDir);
		const modelKey = persisted?.model ?? this.selectNextModel();
		const authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(this.agentDir, "models.json"));
		const model = modelKey ? this.resolveModel(modelRegistry, modelKey) : undefined;
		const settingsManager = SettingsManager.create(this.config.cwd, this.agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.config.cwd,
			agentDir: this.agentDir,
			settingsManager,
			appendSystemPrompt: [WHATSAPP_SYSTEM_PROMPT],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: this.config.cwd,
			agentDir: this.agentDir,
			authStorage,
			modelRegistry,
			model,
			settingsManager,
			resourceLoader,
			sessionManager,
			customTools: [this.createSendMediaTool(chatId) as unknown as ToolDefinition],
		});
		const now = new Date();
		const created: LiveChat = {
			session,
			sessionManager,
			startedAt: persisted ? new Date(persisted.startedAt) : now,
			lastActivity: persisted ? new Date(persisted.lastActivity) : now,
			model: modelKey,
		};
		this.liveChats.set(chatId, created);
		this.updatePersistedChat(chatId, created);
		return created;
	}

	private selectNextModel(): string | undefined {
		if (this.config.models.length === 0) return undefined;
		const model = this.config.models[this.state.nextModel % this.config.models.length];
		this.state.nextModel = (this.state.nextModel + 1) % this.config.models.length;
		return model;
	}

	private resolveModel(modelRegistry: ModelRegistry, key: string): Model<Api> {
		const separator = key.indexOf("/");
		const provider = key.slice(0, separator);
		const id = key.slice(separator + 1);
		const model = modelRegistry.find(provider, id);
		if (!model) throw new Error(`Configured WhatsApp model was not found: ${key}`);
		return model;
	}

	private createSendMediaTool(
		chatId: string,
	): ToolDefinition<typeof SEND_MEDIA_PARAMETERS, Record<string, never>, unknown> {
		return {
			name: "whatsapp_send_media",
			label: "Send WhatsApp media",
			description:
				"Send a local image, document, audio file, voice note, video, or GIF-style video to this WhatsApp chat.",
			parameters: SEND_MEDIA_PARAMETERS,
			execute: async (_toolCallId, params) => {
				await this.outbound.sendMedia({ chatId, ...params });
				return {
					content: [{ type: "text", text: `Sent ${params.kind}: ${basename(params.path)}` }],
					details: {},
				};
			},
		};
	}

	private updatePersistedChat(chatId: string, chat: LiveChat): void {
		this.state.chats[chatId] = {
			sessionFile: chat.sessionManager.materializeSessionFile(this.sessionsDir),
			startedAt: chat.startedAt.toISOString(),
			lastActivity: chat.lastActivity.toISOString(),
			model: chat.model,
		};
		this.persistState();
	}

	private persistState(): void {
		mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, this.statePath);
	}
}
