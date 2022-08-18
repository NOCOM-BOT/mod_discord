# mod_discord for NOCOM_BOT

This is a module that add supports for Discord bot account, following <a href="https://github.com/NOCOM-BOT/spec/blob/main/Module.md#51-interface-handler-module-type--interface">NOCOM_BOT module specification for interface - version 1</a>.

This module uses <a href="https://github.com/discordjs/discord.js">discord.js</a> as backend.

Status: Testing

## Login data parameter

```ts
{
    token: string,
    applicationID?: string,
    intents: GatewayIntentsString[],
    disableSlashCommand?: boolean
}
```

- `token`: Bot token, get from <a href="https://discord.com/developers/applications">Discord Developer Portal</a>

- `applicationID`: Application ID, get from <a href="https://discord.com/developers/applications">Discord Developer Portal</a>. If this parameter does not exist, slash command will be disabled.

- `intents`: Discord gateway intents. See <a href="https://discord-api-types.dev/api/discord-api-types-v10/enum/GatewayIntentBits">Discord API docs</a> for the full list of intents.

    - If you need (and can) support message-based command calling, `Guilds`, `GuildMessages`, `MessageContent` must be enabled. Note that you must have message content intent to enable this.

    - If you want to enable direct message, add `DirectMessages`.

    - Slash command doesn't need any intents.

- `disableSlashCommand`: If you don't want to support slash command, set this to `true`.
