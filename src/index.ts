type TypeOfClassMethod<T, M extends keyof T> = T[M] extends Function ? T[M] : never;

import { Client } from 'discord.js';
import type { GatewayIntentsString, Message, TextChannel, MessageOptions, ReplyMessageOptions } from 'discord.js';
import { setTimeout } from 'timers/promises';
import EventEmitter from 'events';

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
    [id: string]: (rt: IMessageData) => void
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
                let cmdListRQ = await cmc.callAPI(typedModule.namespace, "cmd_list", {});
                if (cmdListRQ.exist && cmdListRQ.data) {
                    for (let cmd of cmdListRQ.data) {
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
        clientID: string,
        intents: GatewayIntentsString[],
        disableSlashCommand?: boolean
    }
}, callback: (error?: any, data?: any) => void) => {
    await lock;

    if (clients[data.interfaceID]) {
        callback("Interface ID exists", { success: false });
        return;
    }

    if (!data.loginData.disableSlashCommand) {
        if (data.loginData.clientID) {
            
        } else {
            logger.warn("discord", `Interface ID ${data.interfaceID} does not have client ID configured, skipping slash command support.`);
        }
    }

    let client = new Client({
        intents: data.loginData.intents
    });

    client
        .login(data.loginData.token).then(() => {
            clients[data.interfaceID] = client;

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
        }).catch(error => {
            callback(String(error), { success: false });
            logger.error("discord", `Interface ${data.interfaceID} login failed.`, String(error));
        });

    client.on("error", () => {
        client.destroy();
        callback(null, { success: false });
        delete clients[data.interfaceID];
    });
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

    let target: (TypeOfClassMethod<TextChannel, 'send'> | TypeOfClassMethod<Message, 'reply'>) =
        typedChannel.send.bind(typedChannel);
    if (typeof messageID === "string") {
        let msg = await typedChannel.messages.fetch(messageID);

        if (msg) {
            target = msg.reply.bind(msg);
        }
    }

    try {
        let sentMsg = await target({
            ...data.additionalInterfaceData,
            content: data.content ?? "",
            // TODO: attachments
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
