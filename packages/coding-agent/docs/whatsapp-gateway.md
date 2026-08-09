# WhatsApp gateway

The gateway connects a personal WhatsApp account through Baileys. It is disabled until a `whatsapp` object with `enabled: true` is present in `~/.fulcrum/settings.json`.

Baileys uses WhatsApp's linked-device protocol, not the Cloud or Business API. It is unofficial and WhatsApp can log out or restrict automated linked devices. Use a personal account only if you accept that risk.

## Configuration

```json
{
  "whatsapp": {
    "enabled": true,
    "cwd": "~/Developer/my-agent-workspace",
    "allowGroups": false,
    "allowedChats": ["15551234567@s.whatsapp.net"],
    "models": [
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.2"
    ],
    "rotation": {
      "inactivityHours": 2,
      "dailyAt": "04:00"
    }
  }
}
```

All fields except `enabled` are optional:

- `authDir`: Baileys linked-device credentials. Default: `~/.fulcrum/gateway/whatsapp-auth`.
- `dataDir`: gateway state, logs, and conversations. Default: `~/.fulcrum/gateway`.
- `mediaDir`: downloaded inbound media. Default: `<dataDir>/media`.
- `cwd`: working directory used by the agent. Default: the directory where `fulcrum gateway start` runs.
- `pairingPhoneNumber`: digits-only phone number for pairing-code login. Omit it to use the QR written to the gateway log.
- `allowGroups`: accept group messages. Default: `false`.
- `allowedChats`: optional exact JID allowlist for direct or group chats.
- `models`: provider/model entries assigned round-robin when a chat starts a new conversation. An empty list uses the normal configured default model. Existing chats keep their selected provider and model.
- `rotation.inactivityHours`: start a new conversation after this many inactive hours. Default: `2`; set `false` to disable.
- `rotation.dailyAt`: start a new conversation after this local-time boundary. Default: `"04:00"`; set `false` to disable.

The gateway reuses the normal provider credentials and custom models from `~/.fulcrum/auth.json` and `~/.fulcrum/models.json`. Configure provider authentication in a terminal before starting it.

## Lifecycle and pairing

```sh
fulcrum gateway start
fulcrum gateway pair
fulcrum gateway status
fulcrum gateway restart
fulcrum gateway stop
```

`start` and `restart` always launch a detached process. There is no public foreground mode. `start` briefly polls the detached worker and prints fresh pairing material when available. `pair` prints the current QR or pairing code on demand without attaching to the worker. `status` prints the PID, connection state, and log path.

For QR pairing, run `fulcrum gateway start`, then `fulcrum gateway pair` if the QR was not ready during the initial two-second poll. Scan it from WhatsApp under **Settings > Linked devices > Link a device**. If `pairingPhoneNumber` is configured, the commands print a pairing code instead. The same material is retained in the owner-only gateway state and log for troubleshooting. Auth files are stored under the configured `authDir` with owner-only permissions.

## Message and media behavior

Each WhatsApp chat has its own persisted agent session and remembered context. A new inbound message interrupts the current provider/tool run for that chat. Any stale response is discarded, and processing restarts with the newest message plus the persisted prior conversation. If several messages arrive while aborting, only the newest pending message runs.

Inbound images, voice notes, audio, video, GIF-style video, and documents are downloaded to `mediaDir`. Images are also attached to providers with image input. Other media is presented to the agent as a local file so installed tools and skills can inspect or transform it.

The `whatsapp_send_media` agent tool sends local images, documents, audio, voice notes, video, and GIF-style video. GIF playback is most reliable with an MP4 file and `kind: "gif"`.

The WhatsApp prompt policy gives the newest message and its attachments priority over older context, asks for concise plain-text replies, quietly reuses durable user context, and permits only specific useful proactive follow-ups. Gateway web research uses the built-in Firecrawl-backed capability.

## Slash commands

Commands are isolated per WhatsApp chat.

| Support | Commands | Behavior |
| --- | --- | --- |
| Gateway-native | `/new`, `/clear` | Dispose the chat's current session and start a new conversation. Text after `/new` becomes the first new prompt. |
| Session engine | `/compact`, `/refine`, `/goal`, `/autonomous` | Routed through the same persistent session command implementation as terminal sessions. |
| Gateway adapters | `/name`, `/session`, `/context`, `/system-prompt`, `/effort`, `/thinking`, `/reload` | Use headless-safe session APIs and return plain WhatsApp text. |
| Packages | extension, skill, and prompt commands | Routed through the normal session input engine when the installed package provides a headless-safe handler. |
| Unsupported | `/settings`, `/model`, `/scoped-models`, `/export`, `/import`, `/share`, `/copy`, `/btw`, `/logs`, `/changelog`, `/update`, `/hotkeys`, `/fork`, `/clone`, `/tree`, `/login`, `/logout`, `/mcp`, `/rlm-max-depth`, `/heartbeat`, `/heartbeats`, `/fullscreen`, `/quit` | These require terminal UI, local clipboard/browser interaction, authentication UI, daemon-client controllers, or process ownership. The gateway replies with a concise terminal-use message. |
