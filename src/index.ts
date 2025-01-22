import { Telegraf } from 'telegraf';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import * as dotenv from 'dotenv';

dotenv.config();

// Telegram API 凭据
const apiId = Number(process.env.API_ID!);
const apiHash = process.env.API_HASH!;
const stringSession = new StringSession(process.env.STRING_SESSION || '');

// Bot API
const bot = new Telegraf(process.env.BOT_TOKEN!);
const sourceChatId = process.env.SOURCE_CHAT_ID!;
const targetChatId = process.env.TARGET_CHAT_ID!;

// 消息队列类型定义
type QueueMessage = {
    type: 'text' | 'photo' | 'video' | 'sticker' | 'document';
    content: any;
    options?: any;
};

// 全局消息队列
const messageQueue: QueueMessage[] = [];
let isProcessing = false;

// 处理消息队列的函数
async function processQueue() {
    if (isProcessing || messageQueue.length === 0) return;
    
    isProcessing = true;
    
    while (messageQueue.length > 0) {
        const message = messageQueue.shift()!;
        try {
            let result;
            switch (message.type) {
                case 'text':
                    result = await bot.telegram.sendMessage(targetChatId, message.content, message.options);
                    break;
                case 'photo':
                    result = await bot.telegram.sendPhoto(targetChatId, message.content, message.options);
                    break;
                case 'video':
                    result = await bot.telegram.sendVideo(targetChatId, message.content, message.options);
                    break;
                case 'sticker':
                    try {
                        result = await bot.telegram.sendSticker(targetChatId, message.content);
                    } catch {
                        result = await bot.telegram.sendDocument(targetChatId, message.content, message.options);
                    }
                    break;
            }
        } catch (error: any) {
            if (error.message.includes('Too Many Requests')) {
                const waitTime = parseInt(error.message.match(/\d+/)[0] || '60');
                console.log('速率限制错误:', {
                    error: error.message,
                    waitTime: `${waitTime}秒`,
                    description: error.description,
                    response: error.response
                });
                messageQueue.unshift(message);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
                continue;
            }
            console.error('发送消息失败:', {
                type: message.type,
                error: {
                    message: error.message,
                    code: error.code,
                    description: error.description,
                    response: error.response,
                    stack: error.stack
                },
                content: message.type === 'text' ? 
                    message.content.substring(0, 100) + '...' : 
                    '媒体内容'
            });
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    isProcessing = false;
}

// 添加消息到队列的函数
function addToQueue(message: QueueMessage) {
    messageQueue.push(message);
    processQueue(); // 尝试处理队列
}

async function initClient() {
    console.log('正在连接到 Telegram...');
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.connect();
    console.log('已连接到 Telegram');
    return client;
}

// 处理消息实体
function processMessageEntities(message: string, entities: any[]): string {
    if (!entities || entities.length === 0) return message;

    // 按照位置排序实体
    const sortedEntities = [...entities].sort((a, b) => a.offset - b.offset);
    let result = '';
    let lastIndex = 0;

    // 按照位置顺序处理每个实体
    // 先按offset和length分组聚合className
    const groupedEntities = new Map<string, any[]>();
    for (const entity of sortedEntities) {
        const key = `${entity.offset}-${entity.length}`;
        if (!groupedEntities.has(key)) {
            groupedEntities.set(key, []);
        }
        groupedEntities.get(key)!.push(entity);
    }

    // 处理每组实体
    for (const [key, entities] of groupedEntities) {
        const [offset, length] = key.split('-').map(Number);
        const text = message.slice(offset, offset + length);

        // 添加实体之前的文本
        result += message.slice(lastIndex, offset);

        // 根据实体类型添加相应的 HTML 标签
        let processedText = text;
        
        // 按顺序应用所有className的格式
        for (const entity of entities) {
            switch (entity.className) {
                case 'MessageEntityBold':
                    processedText = `<b>${processedText}</b>`;
                    break;
                case 'MessageEntityItalic':
                    processedText = `<i>${processedText}</i>`;
                    break;
                case 'MessageEntityCode':
                    processedText = `<code>${processedText}</code>`;
                    break;
                case 'MessageEntityPre':
                    processedText = `<pre>${processedText}</pre>`;
                    break;
                case 'MessageEntityTextUrl':
                    processedText = `<a href="${entity.url}">${processedText}</a>`;
                    break;
                case 'MessageEntityUrl':
                    processedText = `<a href="${processedText}">${processedText}</a>`;
                    break;
            }
        }

        result += processedText;
        lastIndex = offset + length;
    }

    // 添加剩余的文本
    result += message.slice(lastIndex);
    return result;
}

// 处理媒体消息
async function handleMediaMessage(media: any, client: TelegramClient): Promise<QueueMessage | null> {
    const mediaContent = await client.downloadMedia(media);
    if (!mediaContent) return null;

    if ('photo' in media) {
        return {
            type: 'photo',
            content: { source: mediaContent as Buffer }
        };
    } else if ('video' in media) {
        return {
            type: 'video',
            content: { source: mediaContent as Buffer }
        };
    } else if ('sticker' in media || 'document' in media) {
        return {
            type: 'sticker',
            content: { source: mediaContent as Buffer }
        };
    }
    return null;
}

async function start() {
    try {
        const client = await initClient();
        
        client.addEventHandler(async (event) => {
            const message = event.message;
            if (message.chatId?.toString() === sourceChatId) {
                try {
                    // 获取发送者信息
                    const sender = await message.getSender();
                    const senderName = sender ? (
                        'firstName' in sender ?
                            `${sender.firstName || ''} ${sender.lastName || ''}`.trim() :
                            'title' in sender ? sender.title : 'Unknown'
                    ) : 'Unknown';

                    // 先处理消息文本，转义特殊字符
                    const escapedSenderName = senderName
                        .replace(/&/g, '&amp;')
                        .replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;');

                    // 构建基本消息
                    let messageText = `\n👤 [${escapedSenderName}]\n`;
                    
                    // 如果是回复消息，添加引用信息
                    if (message.replyTo) {
                        const replyMsg = await message.getReplyMessage();
                        if (replyMsg && replyMsg.message) { // 只处理包含文本的回复消息
                            const replySender = await replyMsg.getSender();
                            const replySenderName = replySender && 'firstName' in replySender ? 
                                `${replySender.firstName || ''} ${replySender.lastName || ''}`.trim() :
                                'Unknown';
                            const escapedReplySenderName = replySenderName
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;');

                            messageText += `\n↪️ 回复 [${escapedReplySenderName}]:\n`;
                            messageText += `┈┈┈┈┈┈┈┈┈┈\n`;
                            
                            // 处理回复消息的文本
                            let replyText = replyMsg.message;
                            if (replyMsg.entities) {
                                replyText = processMessageEntities(replyMsg.message, replyMsg.entities);
                            }
                            messageText += replyText + '\n';
                            messageText += `┈┈┈┈┈┈┈┈┈┈\n`;
                        }
                    }

                    // 处理主消息内容
                    if (message.message) {
                        let processedMessage = message.message;
                        if (message.entities) {
                            processedMessage = processMessageEntities(message.message, message.entities);
                        }
                        messageText += processedMessage;
                    }

                    // 添加文本消息到队列
                    if (message.message || message.replyTo) {
                        addToQueue({
                            type: 'text',
                            content: messageText,
                            options: {
                                parse_mode: 'HTML',
                                disable_web_page_preview: true
                            }
                        });
                    }

                    // 处理媒体消息
                    if (message.media) {
                        const mediaMessage = await handleMediaMessage(message.media, client);
                        if (mediaMessage) {
                            addToQueue(mediaMessage);
                        }
                    }
                } catch (error: any) {
                    console.error('处理消息时出错:', {
                        error: {
                            message: error.message,
                            code: error.code,
                            description: error.description,
                            response: error.response,
                            stack: error.stack
                        },
                        messageId: message.id,
                        chatId: message.chatId?.toString()
                    });
                }
            }
        }, new NewMessage({}));

        await bot.launch();
        console.log('Bot 和客户端已完全启动，正在监听消息...');
    } catch (error) {
        console.error('启动时出错:', error);
        process.exit(1);
    }
}

start();

// 优雅地处理退出
process.once('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit(0);
});
process.once('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit(0);
}); 