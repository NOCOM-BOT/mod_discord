const DISCORD_SUPPORTED_LANGUAGES = ["da", "de", "en-GB", "en-US", "es-ES", "fr", "hr", "it", "lt", "hu", "nl", "no", "pl", "pt-BR", "ro", "fi", "sv-SE", "vi", "tr", "cs", "el", "bg", "ru", "uk", "hi", "th", "zh-CN", "ja", "zh-TW", "ko"];
type TypeOfClassMethod<T, M extends keyof T> = T[M] extends Function ? T[M] : never;

import { REST } from '@discordjs/rest';
import { Client, Routes, SlashCommandBuilder } from 'discord.js';
import type { GatewayIntentsString, Message, TextChannel, ChatInputCommandInteraction, MessageOptions, ReplyMessageOptions, AttachmentPayload, DMChannel } from 'discord.js';
import { setTimeout } from 'timers/promises';
import EventEmitter from 'events';

import http from 'http';
import https from 'https';
import fs from 'fs';
import { fileURLToPath } from "url";

import CMComm from "./CMC.js";
import Logger from "./Logger.js";

interface IMessageData {
    interfaceID: number;
    content: string;
    attachments: {
        filename: string,
        url: string
    }[],
    channelID: string;
    replyMessageID?: string,
    additionalInterfaceData?: MessageOptions | ReplyMessageOptions
}

type ICommandArgs = [
    name: string,
    desc: {
        fallback: string,
        [ISOLanguageCode: string]: string
    },
    optional: boolean
][];

let cmc = new CMComm();
let logger = new Logger(cmc);
let regCmdSignal = new EventEmitter();

let clients: {
    [id: string]: Client
} = {};

let slashCommandReturn: {
    [id: string]: TypeOfClassMethod<ChatInputCommandInteraction, 'reply'>
} = {};

let resolveLock: () => void = () => { }, lock = new Promise<void>(resolve => {
    resolveLock = resolve;
});

let cmdDB: {
    [command: string]: {
        args: ICommandArgs,
        desc: {
            fallback: string,
            [ISOLanguageCode: string]: string
        }
    }
} = {};

function parseArgs(
    args: {
        fallback: string,
        [ISOLanguageCode: string]: string
    },
    argsName?: string[]
): ICommandArgs {
    // standardized args format (example): 
    // <required arg1> <required arg2> [optional arg3]
    // <required arg1> <required arg2> [optional arg3] [optional arg4]
    // <required arg1> [optional arg2]
    // <required arg1> [optional arg2] [optional arg3]
    // [optional arg1]
    // [optional arg1] [optional arg2]
    // <required arg1]
    // and so on...
    let argsArr: ICommandArgs = [];

    for (let language in args) {
        let argsString = args[language];
        let currentArg: string;
        let currentIndex = 0;

        // Match both <> and []
        // If [], then it's optional, if <>, then it's required
        while (currentArg = argsString.match(/<([^>]+)>|\[([^\]]+)\]/)?.[0] ?? "") {
            argsString = argsString.replace(currentArg, "");

            let optional = currentArg.startsWith("[");
            let argDesc = currentArg.slice(1, -1);

            if (argsArr[currentIndex]) {
                argsArr[currentIndex][1][language] = argDesc;
            } else {
                argsArr.push([
                    (argsName ?? [])[currentIndex] ?? `a${currentIndex + 1}`,
                    {
                        fallback: "FALLBACK_UNKNOWN",
                        [language]: argDesc
                    },
                    optional
                ]);
            }
        }
    }

    if (Array.isArray(argsName) && argsArr.length !== argsName.length) {
        return [["arg", { fallback: "Input" }, false]];
    }

    return argsArr;
}

function constructSlashCommand(commandInfo: {
    command: string,
    data: {
        args: ICommandArgs,
        desc: {
            fallback: string,
            [ISOLanguageCode: string]: string
        }
    }
}) {
    // Build command
    let command = new SlashCommandBuilder()
        .setName(commandInfo.command)
        .setDescription(commandInfo.data.desc.fallback);

    // Description localizations
    for (let [language, description] of Object.entries(commandInfo.data.desc)) {
        // Discord supported languages
        if (DISCORD_SUPPORTED_LANGUAGES.includes(language)) {
            //@ts-ignore
            command.setDescriptionLocalization(language, description);
        }
    }

    // Arguments
    for (let [argName, argDesc, optional] of commandInfo.data.args) {
        command.addStringOption(option => {
            option
                .setName(argName)
                .setDescription(argDesc.fallback)
                .setRequired(!optional);

            for (let [language, description] of Object.entries(argDesc)) {
                // Discord supported languages
                if (DISCORD_SUPPORTED_LANGUAGES.includes(language)) {
                    //@ts-ignore
                    option.setDescriptionLocalization(language, description);
                }
            }

            return option;
        });
    }

    // Accept attachments
    command.addAttachmentOption(option => option
        .setName("attachment")
        .setDescription("Attachment")
        // Must support every Discord supported language
        .setDescriptionLocalizations({
            "en-US": "Attachment",
            "da": "Vedhæftet fil",
            "de": "Anhang",
            "en-GB": "Attachment",
            "es-ES": "Archivo adjunto",
            "fr": "Pièce jointe",
            "hr": "Prilog",
            "it": "Allegato",
            "lt": "Priedas",
            "hu": "Csatolmány",
            "nl": "Bijlage",
            "pl": "Załącznik",
            "pt-BR": "Anexo",
            "ro": "Atașament",
            "ru": "Вложение",
            "tr": "Ek",
            "zh-CN": "附件",
            "zh-TW": "附件",
            "ja": "添付",
            "ko": "첨부파일",
            "vi": "Tệp đính kèm",
            "th": "ไฟล์แนบ",
            "sv-SE": "Bifogat fil",
            "bg": "Приложение",
            "cs": "Příloha",
            "fi": "Liite",
            "el": "Συνημμένο",
            "hi": "संलग्नक",
            "no": "Vedlegg",
            "uk": "Додаток"
        })
        .setRequired(false)
    );

    return command;
}

(async () => {
    // Listen for command register event
    let eventHandlerID = Math.random().toString(10).substring(2) + Math.random().toString(10).substring(2);
    cmc.on(`api:${eventHandlerID}`, (call_from: string, data: {
        calledFrom: string;
        eventName: "cmdhandler_regevent";
        eventData: {
            isRegisterEvent: boolean,
            namespace: string,
            command: string,
            description?: {
                fallback: string,
                [ISOLanguageCode: string]: string
            },
            args?: {
                fallback: string,
                [ISOLanguageCode: string]: string
            },
            argsName?: string[],
            compatibility?: string[]
        };
    }, callback: (error?: any, data?: any) => void) => {
        if (call_from != "core") {
            callback(null, false);
            return;
        }

        if (data.eventName === "cmdhandler_regevent") {
            if (data.eventData.isRegisterEvent) {
                if (
                    Array.isArray(data.eventData.compatibility) &&
                    data.eventData.compatibility.length &&
                    !data.eventData.compatibility.includes("Discord")
                ) return;

                cmdDB[data.eventData.command] = {
                    args: parseArgs(data.eventData.args ?? { fallback: "" }, data.eventData.argsName),
                    desc: data.eventData.description ?? { fallback: "FALLBACK_UNKNOWN" }
                }

                regCmdSignal.emit("register", {
                    command: data.eventData.command,
                    data: cmdDB[data.eventData.command]
                });
            } else {
                if (cmdDB[data.eventData.command]) {
                    delete cmdDB[data.eventData.command];
                    regCmdSignal.emit("unregister", {
                        command: data.eventData.command
                    });
                }
            }
        }
    });
    await cmc.callAPI("core", "register_event_hook", {
        callbackFunction: eventHandlerID,
        eventName: "cmdhandler_regevent"
    });

    // Find command resolver and get initial command list
    let moduleListRQ = await cmc.callAPI("core", "get_registered_modules", {});
    if (moduleListRQ.exist && moduleListRQ.data) {
        for (let module of moduleListRQ.data) {
            let typedModule = module as {
                moduleID: string,
                type: string,
                namespace: string,
                displayname: string,
                running: boolean
            };

            if (typedModule.type === "cmd_handler") {
                if (!typedModule.running) {
                    let reqTO = await cmc.callAPI("core", "wait_for_module", {
                        moduleNamespace: typedModule.namespace,
                        timeout: 10000
                    });

                    if (!reqTO.exist || (reqTO.exist && !reqTO.data)) {
                        continue;
                    }
                }

                // Request command list
                let cmdListRQ = await cmc.callAPI(typedModule.moduleID, "cmd_list", {});
                if (cmdListRQ.exist && cmdListRQ.data && Array.isArray(cmdListRQ.data?.commands)) {
                    for (let cmd of cmdListRQ.data.commands) {
                        let typedCmd = cmd as {
                            command: string,
                            description?: {
                                fallback: string,
                                [ISOLanguageCode: string]: string
                            },
                            args?: {
                                fallback: string,
                                [ISOLanguageCode: string]: string
                            },
                            argsName?: string[],
                            compatibility?: string[]
                        };

                        if (Array.isArray(typedCmd.compatibility) && typedCmd.compatibility.length && !typedCmd.compatibility.includes("Discord")) {
                            continue;
                        }

                        cmdDB[typedCmd.command] = {
                            args: parseArgs(typedCmd.args ?? { fallback: "" }, typedCmd.argsName),
                            desc: typedCmd.description ?? { fallback: "FALLBACK_UNKNOWN" }
                        };

                        regCmdSignal.emit("register", {
                            command: typedCmd.command,
                            data: cmdDB[typedCmd.command]
                        });
                    }
                }
            }
        }
    }

    // Only allow API input after 10s to ensure that every command is loaded.
    await setTimeout(10000);
    resolveLock();
})();

cmc.on("api:login", async (call_from: string, data: {
    interfaceID: number;
    loginData: {
        token: string,
        applicationID: string,
        intents: GatewayIntentsString[],
        disableSlashCommand?: boolean
    }
}, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (clients[data.interfaceID]) {
        callback("Interface ID exists", { success: false });
        return;
    }

    let rest = new REST({ version: '10' }).setToken(data.loginData.token);

    async function registerCommandEvent(eventData: {
        command: string,
        data: {
            args: ICommandArgs,
            desc: {
                fallback: string,
                [ISOLanguageCode: string]: string
            }
        }
    }) {
        try {
            // Build slash command
            let slashCmd = constructSlashCommand(eventData);

            // Publish command to Discord
            await rest.put(
                Routes.applicationCommands(data.loginData.applicationID),
                {
                    body: [
                        slashCmd.toJSON()
                    ]
                }
            );
        } catch { }
    }

    if (!data.loginData.disableSlashCommand) {
        if (data.loginData.applicationID) {
            regCmdSignal.on("register", registerCommandEvent);

            try {
                let cmdBuild = Object.entries(cmdDB).map(([command, data]) => constructSlashCommand({
                    command,
                    data
                }).toJSON());

                await rest.put(
                    Routes.applicationCommands(data.loginData.applicationID),
                    {
                        body: cmdBuild
                    }
                );
            } catch (e) {
                throw `Failed to register slash command: ${String(e)}`;
            }
        } else {
            logger.warn("discord", `Interface ID ${data.interfaceID} does not have application ID configured, skipping slash command support.`);
        }
    }

    let client = new Client({
        intents: data.loginData.intents
    });

    client.on("error", () => {
        client.destroy();
        delete clients[data.interfaceID];
    });

    try {
        await client.login(data.loginData.token)
    } catch (error) {
        callback(String(error), { success: false });
        logger.error("discord", `Interface ${data.interfaceID} login failed.`, String(error));
    }

    clients[data.interfaceID] = client;

    client.on("interactionCreate", async interaction => {
        // Only allow chat input.
        if (!interaction.isChatInputCommand()) return;

        let command = interaction.commandName;
        // Check if the command exists.
        if (cmdDB.hasOwnProperty(command)) {
            // We don't know how long the command will be executed, so we need to acknowledge it first.
            await interaction.deferReply();

            // Convert interaction back to standard commands
            let parsedArgs: string[] = [];
            for (let arg of cmdDB[command].args) {
                let opt = interaction.options.get(arg[0]);
                if (opt) {
                    parsedArgs.push(String(opt.value ?? ""));
                } else {
                    parsedArgs.push("");
                }
            }

            let stdCmd = `/${command} ${parsedArgs.join(" ")}`;

            // Get attachment
            let att = interaction.options.get("attachment");
            let processedAtt = [];
            if (att && att.attachment) {
                processedAtt.push({
                    filename: att.attachment.name ?? "unknown.png",
                    url: att.attachment.url
                });
            }

            // Save reply function to slashCommandReturn for replying later when cmdhandler call API.
            slashCommandReturn[interaction.id] = interaction.reply.bind(interaction);

            // Broadcast converted message to command handlers
            cmc.callAPI("core", "send_event", {
                eventName: "interface_message",
                data: {
                    interfaceID: data.interfaceID,
                    interfaceHandlerName: "Discord",

                    content: stdCmd,
                    attachments: processedAtt,

                    // Mention parsing is not implemented yet. TODO
                    mentions: {},

                    messageID: interaction.id,
                    formattedMessageID: `${interaction.id}@SlashCommand@Discord`,
                    channelID: interaction.channelId,
                    formattedChannelID: `${interaction.channelId}@Channel@Discord`,
                    guildID: interaction.guildId ?? interaction.channelId,
                    formattedGuildID: interaction.guildId ?
                        `${interaction.guildId}@Guild@Discord` :
                        `${interaction.channelId}@Channel@Discord`,
                    senderID: interaction.user.id,
                    formattedSenderID: `${interaction.user.id}@User@Discord`,

                    additionalInterfaceData: {
                        discord_isSlashCommand: true
                    }
                }
            });
        }
    });

    client.on("messageCreate", message => {
        // Broadcast incoming message event for command handlers
        cmc.callAPI("core", "send_event", {
            eventName: "interface_message",
            data: {
                interfaceID: data.interfaceID,
                interfaceHandlerName: "Discord",

                content: message.content,
                attachments: message.attachments.map(attachment => {
                    return {
                        filename: attachment.name ?? "unknown.png",
                        url: attachment.url
                    };
                }),

                mentions: Object.fromEntries(message.mentions.users.map(user => {
                    return [`${user.id}@User@Discord`, {
                        start: message.content.indexOf(`<@${user.id}>`),
                        length: `<@${user.id}>`.length
                    }]
                })),

                messageID: message.id,
                formattedMessageID: `${message.id}@Message@Discord`,
                channelID: message.channel.id,
                formattedChannelID: `${message.channel.id}@Channel@Discord`,
                guildID: message.guild?.id ?? message.channel.id,
                formattedGuildID: message.guild ?
                    `${message.guild.id}@Guild@Discord` :
                    `${message.channel.id}@Channel@Discord`,
                senderID: message.author.id,
                formattedSenderID: `${message.author.id}@User@Discord`,

                additionalInterfaceData: {}
            }
        });
    });

    callback(null, {
        success: true,
        interfaceID: data.interfaceID,
        accountName: client.user?.tag,
        rawAccountID: client.user?.id,
        formattedAccountID: `${client.user?.id}@User@Discord`,
        accountAdditionalData: {}
    });
    logger.info("discord", `Interface ${data.interfaceID} logged in.`);
});

cmc.on("api:logout", async (call_from: string, data: {
    interfaceID: number
}, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (clients[data.interfaceID]) {
        clients[data.interfaceID].destroy();
    }
    delete clients[data.interfaceID];

    callback(null, null);
});

cmc.on("api:send_message", async (call_from: string, data: IMessageData, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (!clients[data.interfaceID]) {
        callback("Interface ID does not exist", { success: false });
        return;
    }

    let target: (
        TypeOfClassMethod<TextChannel, 'send'> |
        TypeOfClassMethod<Message, 'reply'> |
        TypeOfClassMethod<ChatInputCommandInteraction, 'reply'>
    );
    if (data.replyMessageID && slashCommandReturn.hasOwnProperty(data.replyMessageID)) {
        // Reply to slash command, ignoring channelID
        target = slashCommandReturn[data.replyMessageID];
    } else {
        // Standard message sending
        let client = clients[data.interfaceID];
        let channelID = data.channelID;
        let messageID = data.replyMessageID;

        if (channelID.split("@").length > 1) {
            channelID = channelID.split("@")[0];
        }
        if (typeof messageID === "string" && messageID.split("@").length > 1) {
            messageID = messageID.split("@")[0];
        }

        let channel = await client.channels.fetch(channelID);
        if (!channel) {
            callback("Channel does not exist", { success: false });
            return;
        }

        if (!channel.isTextBased() && !channel.isThread()) {
            callback("Channel is not text-based", { success: false });
            return;
        }

        let typedChannel = channel as TextChannel;
        target = typedChannel.send.bind(typedChannel);

        if (typeof messageID === "string") {
            let msg = await typedChannel.messages.fetch(messageID);

            if (msg) {
                target = msg.reply.bind(msg);
            }
        }
    }

    try {
        //@ts-ignore bruh
        let sentMsg = await target({
            ...data.additionalInterfaceData,
            content: data.content ?? "",
            files: (data.attachments?.map?.(attachment => {
                if (attachment.url.startsWith("data:")) {
                    // Check if it's base64-encoded or URL-encoded by checking if 
                    // it has ";base64" in "data:<mime>;base64,<data>"
                    if (attachment.url.split(";")[1].startsWith("base64")) {
                        // Base64
                        return {
                            attachment: Buffer.from(attachment.url.split(",")[1], "base64"),
                            name: attachment.filename
                        } as AttachmentPayload;
                    } else {
                        // URL-encoded (percent-encoded)
                        return {
                            attachment: Buffer.from(decodeURIComponent(attachment.url.split(",")[1])),
                            name: attachment.filename
                        } as AttachmentPayload;
                    }
                } else {
                    // Parse URL with protocol
                    let parsedURL = new URL(attachment.url);
                    switch (parsedURL.protocol) {
                        case "http:":
                            let httpReq = http.get(parsedURL.toString());
                            return {
                                attachment: httpReq,
                                name: attachment.filename
                            } as AttachmentPayload;
                        case "https:":
                            let httpsReq = https.get(parsedURL.toString());
                            return {
                                attachment: httpsReq,
                                name: attachment.filename
                            } as AttachmentPayload;
                        case "file:":
                            return {
                                attachment: fs.createReadStream(fileURLToPath(parsedURL.toString())),
                                name: attachment.filename
                            } as AttachmentPayload;
                        default:
                            return null;
                    }
                }
            }) ?? []).filter(x => x) as AttachmentPayload[]
        });

        callback(null, {
            success: true,
            messageID: sentMsg.id,
            additionalInterfaceData: {}
        });
    } catch (e) {
        callback(null, {
            success: false
        });
    }
});

cmc.on("api:get_userinfo", async (call_from: string, data: {
    interfaceID: number,
    userID: string
}, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (!clients[data.interfaceID]) {
        callback("Interface ID does not exist", { success: false });
        return;
    }

    let client = clients[data.interfaceID];
    let userID = data.userID;

    if (userID.split("@").length > 1) {
        userID = userID.split("@")[0];
    }

    let user = await client.users.fetch(userID);

    if (!user) {
        callback("User does not exist", {});
        return;
    }

    callback(null, {
        name: user.tag
    });
});

cmc.on("api:get_channelinfo", async (call_from: string, data: {
    interfaceID: number,
    channelID: string
}, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (!clients[data.interfaceID]) {
        callback("Interface ID does not exist", { success: false });
        return;
    }

    let client = clients[data.interfaceID];
    let channelID = data.channelID;

    if (channelID.split("@").length > 1) {
        channelID = channelID.split("@")[0];
    }

    let channel = await client.channels.fetch(channelID);

    if (!channel) {
        callback("Channel does not exist", {});
        return;
    }

    let channelName = "";

    if (channel.isDMBased()) {
        channelName = (channel as DMChannel).recipient?.tag ?? "";
    } else {
        channelName = channel.name;
    }

    callback(null, {
        channelName,
        type: channel.type
    });
});
