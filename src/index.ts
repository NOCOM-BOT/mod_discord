type TypeOfClassMethod<T, M extends keyof T> = T[M] extends Function ? T[M] : never;

import { Client } from 'discord.js';
import type { GatewayIntentsString, Message, TextChannel, MessageOptions, ReplyMessageOptions } from 'discord.js';

import CMComm from "./CMC";
import Logger from "./Logger";

let cmc = new CMComm();
let logger = new Logger(cmc);

let clients: {
    [id: string]: Client
} = {};

cmc.on("api:login", (call_from: string, data: {
    interfaceID: number;
    loginData: {
        token: string,
        intents: GatewayIntentsString[]
    }
}, callback: (error?: any, data?: any) => void) => {
    if (clients[data.interfaceID]) {
        callback("Interface ID exists", { success: false });
        return;
    }

    let client = new Client({
        intents: data.loginData.intents
    });

    client
        .login(data.loginData.token).then(() => {
            clients[data.interfaceID] = client;

            client.on("messageCreate", message => {
                // Broadcase incoming message event for command handlers
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
                        messageID: message.id,
                        channelID: message.channel.id,
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

    client.on("error", () => {
        client.destroy();
        callback(null, { success: false });
        delete clients[data.interfaceID];
    });
});

cmc.on("api:logout", (call_from: string, data: {
    interfaceID: number
}, callback: (error?: any, data?: any) => void) => {
    if (clients[data.interfaceID]) {
        clients[data.interfaceID].destroy();
    }
    delete clients[data.interfaceID];

    callback(null, null);
});

cmc.on("api:send_message", async (call_from: string, data: {
    interfaceID: number;
    content: string;
    attachments: {
        filename: string,
        url: string
    }[],
    channelID: string;
    replyMessageID?: string,
    additionalInterfaceData?: MessageOptions | ReplyMessageOptions
}, callback: (error?: any, data?: any) => void) => {
    if (!clients[data.interfaceID]) {
        callback("Interface ID does not exist", { success: false });
        return;
    }

    let client = clients[data.interfaceID];

    let channel = await client.channels.fetch(data.channelID);
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
    if (data.replyMessageID) {
        let msg = await typedChannel.messages.fetch(data.replyMessageID);

        if (msg) {
            target = msg.reply.bind(msg);
        }
    }

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
});
