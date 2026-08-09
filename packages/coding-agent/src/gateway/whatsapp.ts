import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import makeWASocket, {
	type AnyMessageContent,
	Browsers,
	DEFAULT_CONNECTION_CONFIG,
	DisconnectReason,
	downloadMediaMessage,
	normalizeMessageContent,
	toNumber,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import * as qrcode from "qrcode-terminal";
import { writeGatewayPairingMaterial, writeGatewayRuntimeStatus } from "../cli/gateway-command.js";
import { getAgentDir } from "../config.js";
import { WhatsAppAgentConversationProcessor, type WhatsAppOutboundMedia } from "./agent-conversation.js";
import type { WhatsAppGatewayConfig } from "./config.js";
import {
	type GatewayInboundMessage,
	type GatewayMessageSender,
	LatestMessageCoordinator,
} from "./conversation-coordinator.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function disconnectStatusCode(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	if (typeof error.statusCode === "number") return error.statusCode;
	const output = error.output;
	return isRecord(output) && typeof output.statusCode === "number" ? output.statusCode : undefined;
}

function safeFileSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
	return sanitized || "media";
}

function extensionFromMime(mimeType: string): string {
	const extension = mimeType
		.split("/")[1]
		?.split(";")[0]
		?.replace(/[^a-zA-Z0-9]/g, "");
	return extension ? `.${extension}` : ".bin";
}

function splitWhatsAppText(text: string): string[] {
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > 3900) {
		let splitAt = remaining.lastIndexOf("\n", 3900);
		if (splitAt < 1000) splitAt = remaining.lastIndexOf(" ", 3900);
		if (splitAt < 1000) splitAt = 3900;
		chunks.push(remaining.slice(0, splitAt).trim());
		remaining = remaining.slice(splitAt).trim();
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

export class WhatsAppGateway implements GatewayMessageSender {
	private socket?: WASocket;
	private stopped = false;
	private reconnectTimer?: NodeJS.Timeout;
	private stopPromise?: Promise<void>;
	private readonly logger = DEFAULT_CONNECTION_CONFIG.logger.child({ component: "fulcrum-whatsapp-gateway" });
	private readonly coordinator: LatestMessageCoordinator;
	private readonly processor: WhatsAppAgentConversationProcessor;

	constructor(private readonly config: WhatsAppGatewayConfig) {
		this.logger.level = "silent";
		this.processor = new WhatsAppAgentConversationProcessor(config, this, getAgentDir());
		this.coordinator = new LatestMessageCoordinator(this.processor, this);
	}

	async start(): Promise<void> {
		mkdirSync(this.config.authDir, { recursive: true, mode: 0o700 });
		mkdirSync(this.config.mediaDir, { recursive: true, mode: 0o700 });
		await this.connect();
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.socket?.end(undefined);
		this.socket = undefined;
		this.stopPromise = this.processor.dispose();
		return this.stopPromise;
	}

	async sendText(chatId: string, text: string): Promise<void> {
		const socket = this.requireSocket();
		for (const chunk of splitWhatsAppText(text)) {
			await socket.sendMessage(chatId, { text: chunk });
		}
	}

	async sendMedia(media: WhatsAppOutboundMedia): Promise<void> {
		const socket = this.requireSocket();
		const path = isAbsolute(media.path) ? media.path : resolve(this.config.cwd, media.path);
		if (!existsSync(path)) throw new Error(`Media file does not exist: ${path}`);
		const content = readFileSync(path);
		let outgoing: AnyMessageContent;
		switch (media.kind) {
			case "image":
				outgoing = { image: content, caption: media.caption, mimetype: media.mimeType };
				break;
			case "audio":
				outgoing = { audio: content, ptt: false, mimetype: media.mimeType };
				break;
			case "voice":
				outgoing = { audio: content, ptt: true, mimetype: media.mimeType ?? "audio/ogg; codecs=opus" };
				break;
			case "video":
				outgoing = { video: content, caption: media.caption, mimetype: media.mimeType };
				break;
			case "gif":
				outgoing = { video: content, caption: media.caption, gifPlayback: true, mimetype: media.mimeType };
				break;
			case "document":
				outgoing = {
					document: content,
					caption: media.caption,
					mimetype: media.mimeType ?? "application/octet-stream",
					fileName: safeFileSegment(media.path.split(/[\\/]/).at(-1) ?? "document"),
				};
				break;
		}
		await socket.sendMessage(media.chatId, outgoing);
	}

	private requireSocket(): WASocket {
		if (!this.socket) throw new Error("WhatsApp is not connected");
		return this.socket;
	}

	private async connect(): Promise<void> {
		const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);
		const socket = makeWASocket({
			auth: state,
			browser: Browsers.appropriate("Fulcrum"),
			logger: this.logger,
			markOnlineOnConnect: false,
			syncFullHistory: false,
			shouldSyncHistoryMessage: () => false,
		});
		this.socket = socket;
		socket.ev.on("creds.update", saveCreds);
		socket.ev.on("connection.update", (update) => {
			if (update.qr) {
				writeGatewayPairingMaterial({ type: "qr", value: update.qr, updatedAt: new Date().toISOString() });
				console.log("Scan this QR in WhatsApp: Settings > Linked devices > Link a device.");
				qrcode.generate(update.qr, { small: true }, (rendered) => console.log(rendered));
			}
			if (update.connection === "open") {
				writeGatewayPairingMaterial(undefined);
				writeGatewayRuntimeStatus({ state: "connected", updatedAt: new Date().toISOString() });
				console.log("WhatsApp connected.");
			}
			if (update.connection === "close") {
				const code = disconnectStatusCode(update.lastDisconnect?.error);
				const loggedOut = code === DisconnectReason.loggedOut;
				writeGatewayRuntimeStatus({
					state: loggedOut ? "error" : "disconnected",
					updatedAt: new Date().toISOString(),
					detail: loggedOut
						? "WhatsApp logged out; remove the auth directory and pair again."
						: `Connection closed${code ? ` (${code})` : ""}`,
				});
				if (!this.stopped && !loggedOut) {
					this.reconnectTimer = setTimeout(() => void this.connect(), 2000);
				}
			}
		});
		socket.ev.on("messages.upsert", ({ messages, type }) => {
			if (type !== "notify") return;
			for (const message of messages) {
				void this.acceptMessage(message).catch((error) => {
					console.error(
						`Failed to accept WhatsApp message: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
		});

		if (!state.creds.registered && this.config.pairingPhoneNumber) {
			const code = await socket.requestPairingCode(this.config.pairingPhoneNumber);
			writeGatewayPairingMaterial({ type: "code", value: code, updatedAt: new Date().toISOString() });
			console.log(`WhatsApp pairing code: ${code}`);
		}
	}

	private async acceptMessage(message: WAMessage): Promise<void> {
		const chatId = message.key.remoteJid;
		if (!chatId || message.key.fromMe || chatId === "status@broadcast" || chatId.endsWith("@broadcast")) return;
		if (chatId.endsWith("@g.us") && !this.config.allowGroups) return;
		if (this.config.allowedChats && !this.config.allowedChats.has(chatId)) return;
		const content = normalizeMessageContent(message.message);
		if (!content) return;

		const text =
			content.conversation ??
			content.extendedTextMessage?.text ??
			content.imageMessage?.caption ??
			content.videoMessage?.caption ??
			content.documentMessage?.caption ??
			"";
		const media = await this.downloadMessageMedia(message, content, chatId);
		if (!text.trim() && media.length === 0) return;
		const timestamp = message.messageTimestamp ? toNumber(message.messageTimestamp) * 1000 : Date.now();
		const inbound: GatewayInboundMessage = {
			id: message.key.id ?? `${chatId}:${timestamp}`,
			chatId,
			text: text.trim(),
			sentAt: new Date(timestamp),
			media,
		};
		this.coordinator.accept(inbound);
	}

	private async downloadMessageMedia(
		message: WAMessage,
		content: NonNullable<ReturnType<typeof normalizeMessageContent>>,
		chatId: string,
	): Promise<GatewayInboundMessage["media"]> {
		const descriptor = content.imageMessage
			? { kind: "image" as const, message: content.imageMessage }
			: content.audioMessage
				? {
						kind: content.audioMessage.ptt ? ("voice" as const) : ("audio" as const),
						message: content.audioMessage,
					}
				: content.videoMessage
					? {
							kind: content.videoMessage.gifPlayback ? ("gif" as const) : ("video" as const),
							message: content.videoMessage,
						}
					: content.documentMessage
						? { kind: "document" as const, message: content.documentMessage }
						: undefined;
		if (!descriptor) return [];
		const buffer = await downloadMediaMessage(message, "buffer", {});
		const mimeType = descriptor.message.mimetype ?? "application/octet-stream";
		const originalName = "fileName" in descriptor.message ? descriptor.message.fileName : undefined;
		const extension = originalName ? extname(originalName) : extensionFromMime(mimeType);
		const directory = join(this.config.mediaDir, safeFileSegment(chatId));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const path = join(directory, `${safeFileSegment(message.key.id ?? String(Date.now()))}${extension || ".bin"}`);
		writeFileSync(path, buffer, { mode: 0o600 });
		return [
			{
				kind: descriptor.kind,
				path,
				mimeType,
				fileName: originalName ?? undefined,
				data: descriptor.kind === "image" ? buffer.toString("base64") : undefined,
			},
		];
	}
}
