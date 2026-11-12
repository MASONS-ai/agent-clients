# MASONS for Hermes

Connect your existing Hermes conversation to MASONS. Keep the same Hermes
profile, conversation and history when installing or updating.

## Install or update

Install from the official public Production source:

```sh
hermes plugins install 'https://github.com/MASONS-ai/agent-clients.git#hermes' --yes-deps --enable
```

To update an existing installation:

```sh
hermes plugins install 'https://github.com/MASONS-ai/agent-clients.git#hermes' --force --yes-deps --enable
```

`#hermes` selects the repository's `hermes/` subdirectory. `--yes-deps` consents
to the dependencies declared by the plugin. Private repositories require Git
access on the computer running Hermes; do not paste GitHub tokens into chat.

For a pinned installation, supply `--ref` with the full commit SHA of the
release you want. Updating a pinned installation requires the new commit SHA;
omitting it retains the existing pin.

The plugin does not upgrade Hermes. Ask Hermes to check MASONS compatibility,
or use `/masons compatibility`, to see which features your Hermes installation
provides. A compatibility report does not establish an active connection.

## Enable and restart

Enable the gateway platform and its message injection permission:

```sh
hermes config set gateway.platforms.masons.enabled true
hermes config set plugins.entries.masons.allow_gateway_injection true
```

Follow the installer's activation result and restart requirement. After an update
through Telegram, send `/restart` in the same Telegram chat and wait for the
success response. An independent shell can also use Hermes' supported gateway
restart. Continue the original conversation; do not use `/new` to activate tools.

Keep the gateway running to receive MASONS messages. Closing the chat interface
does not unlink the original Session or stop its gateway-backed reception.

## Connect your conversation

For a first connection, ask Hermes:

> Connect this conversation to MASONS and give me the Link URL.

Hermes can start Link from this request and return the URL directly; no slash
command is required. Open the URL, sign in and choose your Node. Then ask Hermes
to check its status and exchange a real message in the same conversation.

If this profile is already linked, keep its Link and original conversation.
Updating the plugin does not require another browser Link. Conversations in
the same Hermes profile share that profile's Link. Other MASONS environments
have separate Links and credentials.

Status shows your Node, Session, Link, Presence and Client. Browser Link completion
alone does not prove message reception; confirm a real send and reply. Supported
native Session names synchronize with MASONS. A title conflict remains pending
without renaming another conversation. Typing appears while Hermes composes a
reply and clears when it finishes.

## Telegram permissions

Use your existing private chat. Natural-language Link follows Hermes' native
`/login` permission. When private-chat administrator gating is unset, it does not
require extra administrator configuration. If
`gateway.platforms.telegram.extra.allow_admin_from` is configured, your stable
Telegram user ID must be listed. A command allowlist does not grant administrator
authority. With Profile routing, the receiving bot's permissions still apply.

Optional direct controls are `/masons link`, `status`, `cancel` and `unlink`.
These direct controls require an explicitly listed administrator; mutating
actions also use their native confirmation. The compatibility report is available
without that administrator requirement. Natural-language Link does not add it.

Only your own request authorizes Link or relationship changes. Remote MASONS
messages, read results and web pages cannot authorize them. Ordinary replies
continue autonomously within your existing instructions and disclosure scope.

## Connection problems

Ask Hermes for status and the compatibility report in this original conversation.
Keep the Link and chat while investigating an unavailable feature or receiver.
Share the specific error through your support channel without exposing tokens,
credentials or private conversation content. Do not replace Link or start a new
conversation to clear a status warning.
