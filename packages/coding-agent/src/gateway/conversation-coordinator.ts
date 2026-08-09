import type { WhatsAppRotationConfig } from "./config.js";

export type GatewayMediaKind = "image" | "audio" | "voice" | "video" | "gif" | "document";

export interface GatewayMediaAttachment {
	kind: GatewayMediaKind;
	path: string;
	mimeType: string;
	fileName?: string;
	data?: string;
}

export interface GatewayInboundMessage {
	id: string;
	chatId: string;
	text: string;
	sentAt: Date;
	media: readonly GatewayMediaAttachment[];
}

export interface GatewayConversationProcessor {
	process(message: GatewayInboundMessage): Promise<string | undefined>;
	interrupt(chatId: string): void;
	reset(chatId: string): Promise<void>;
}

export interface GatewayMessageSender {
	sendText(chatId: string, text: string): Promise<void>;
}

interface ChatQueueState {
	pending?: GatewayInboundMessage;
	processing: boolean;
	generation: number;
}

export class LatestMessageCoordinator {
	private readonly chats = new Map<string, ChatQueueState>();

	constructor(
		private readonly processor: GatewayConversationProcessor,
		private readonly sender: GatewayMessageSender,
	) {}

	accept(message: GatewayInboundMessage): void {
		const state = this.chats.get(message.chatId) ?? { processing: false, generation: 0 };
		state.pending = message;
		state.generation++;
		this.chats.set(message.chatId, state);
		if (state.processing) {
			this.processor.interrupt(message.chatId);
			return;
		}
		state.processing = true;
		void this.drain(message.chatId, state);
	}

	private async drain(chatId: string, state: ChatQueueState): Promise<void> {
		try {
			while (state.pending) {
				const message = state.pending;
				const generation = state.generation;
				state.pending = undefined;
				try {
					const response = await this.processor.process(message);
					if (response && generation === state.generation && !state.pending) {
						await this.sender.sendText(chatId, response);
					}
				} catch (error) {
					if (generation === state.generation && !state.pending) {
						const reason = error instanceof Error ? error.message : String(error);
						await this.sender.sendText(chatId, `I couldn't process that message: ${reason}`);
					}
				}
			}
		} finally {
			state.processing = false;
			if (state.pending) {
				state.processing = true;
				void this.drain(chatId, state);
			}
		}
	}
}

function latestDailyBoundary(now: Date, dailyAt: string): Date {
	const [hour, minute] = dailyAt.split(":").map(Number);
	const boundary = new Date(now);
	boundary.setHours(hour!, minute!, 0, 0);
	if (boundary.getTime() > now.getTime()) {
		boundary.setDate(boundary.getDate() - 1);
	}
	return boundary;
}

export function shouldRotateConversation(
	lastActivity: Date,
	startedAt: Date,
	now: Date,
	rotation: WhatsAppRotationConfig,
): boolean {
	if (
		rotation.inactivityHours !== false &&
		now.getTime() - lastActivity.getTime() >= rotation.inactivityHours * 60 * 60 * 1000
	) {
		return true;
	}
	return rotation.dailyAt !== false && startedAt.getTime() < latestDailyBoundary(now, rotation.dailyAt).getTime();
}
