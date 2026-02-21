       const axios = require('axios');
const fs   = require('fs');
const { getAllCustomers } = require('./customers');
const { setOOO, getOOOConfig } = require('./ooo');
const { getAllPromos, addPromo, updatePromo, deletePromo } = require('./campaigns');

/**
 * Main command dispatcher
 */
async function handleCommand(client, msg, prefix) {
    const args = msg.body.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    console.log(`[CMD] Command: ${command} | Args: ${args.join(', ')}`);

    try {
    switch (command) {

        case 'broadcast':
            await handleBroadcast(client, msg, args);
            break;

        case 'customers':
            await handleCustomers(msg);
            break;

        case 'ooo':
            await handleOOO(msg, args);
            break;

        case 'promo':
            await handlePromo(msg, args);
            break;

        case 'ping': {
                const pingChat = await msg.getChat();
                await pingChat.sendMessage('🏓 Pong! Bot is alive.');
                break;
            }

        case 'help':
            await msg.reply(getHelpText(prefix));
            break;

        case 'info':
            await handleInfo(msg);
            break;

        case 'joke':
            await handleJoke(msg);
            break;

        case 'quote':
            await handleQuote(msg);
            break;

        case 'weather':
            await msg.reply('🌤️ Weather feature coming soon! (Add an API key in .env to enable it)');
            break;

        case 'sticker':
            await handleSticker(client, msg);
            break;

        case 'tagall':
            await handleTagAll(client, msg);
            break;

        case 'say':
            if (args.length === 0) {
                await msg.reply('❌ Usage: !say <your message>');
            } else {
                await msg.reply(args.join(' '));
            }
            break;

        default:
            await msg.reply(`❓ Unknown command: *${command}*\nType *${prefix}help* for a list of commands.`);
            break;
    }
    } catch (err) {
        console.error(`[CMD ERROR] Command "${command}" failed:`, err.message);
    }
}

function getHelpText(prefix) {
    return `*🤖 WhatsApp Bot Commands*\n
${prefix}ping              — Check if bot is alive
${prefix}help              — Show this menu
${prefix}info              — Show chat/group info
${prefix}joke              — Get a random joke
${prefix}quote             — Get an inspirational quote
${prefix}sticker           — Convert image to sticker
${prefix}tagall            — Tag all members (groups only)
${prefix}say <text>        — Make the bot say something
${prefix}customers         — List all saved customers
${prefix}broadcast <msg>   — Send message to all customers
${prefix}ooo on|off        — Toggle Out of Office mode
${prefix}ooo msg <text>    — Set custom OOO message
${prefix}promo list        — List all promo blasts
${prefix}promo add <day> <HH:MM> <msg> — Schedule a promo (day: 0-6 or -1 for daily)
${prefix}promo on|off <id> — Enable/disable a promo
${prefix}promo del <id>    — Delete a promo
${prefix}promo send <id>   — Send a promo now`;
}

async function handleInfo(msg) {
    const chat = await msg.getChat();
    const contact = await msg.getContact();

    let info = `*📋 Chat Info*\n`;
    info += `Name: ${chat.name}\n`;
    info += `Type: ${chat.isGroup ? 'Group' : 'Private'}\n`;
    if (chat.isGroup) {
        info += `Members: ${chat.participants.length}\n`;
    }
    info += `From: ${contact.pushname || contact.number}`;

    await msg.reply(info);
}

async function handleJoke(msg) {
    try {
        const response = await axios.get('https://official-joke-api.appspot.com/random_joke', { timeout: 5000 });
        const { setup, punchline } = response.data;
        await msg.reply(`😂 *Joke*\n\n${setup}\n\n${punchline}`);
    } catch (err) {
        await msg.reply('😅 Could not fetch a joke right now. Try again later!');
    }
}

async function handleQuote(msg) {
    try {
        const response = await axios.get('https://zenquotes.io/api/random', { timeout: 5000 });
        const { q, a } = response.data[0];
        await msg.reply(`💡 *Quote*\n\n"${q}"\n— ${a}`);
    } catch (err) {
        await msg.reply('😅 Could not fetch a quote right now. Try again later!');
    }
}

async function handleSticker(client, msg) {
    const quotedMsg = await msg.getQuotedMessage().catch(() => null);
    const target = quotedMsg || msg;

    if (!target.hasMedia) {
        await msg.reply('❌ Please reply to an image/video with *!sticker* to convert it.');
        return;
    }

    const media = await target.downloadMedia();
    await msg.reply(media, null, { sendMediaAsSticker: true });
}

async function handleTagAll(client, msg) {
    const chat = await msg.getChat();

    if (!chat.isGroup) {
        await msg.reply('❌ This command only works in groups.');
        return;
    }

    let text = '📢 *Attention everyone!*\n';
    const mentions = [];

    for (const participant of chat.participants) {
        const contact = await client.getContactById(participant.id._serialized);
        mentions.push(contact);
        text += `@${participant.id.user} `;
    }

    await chat.sendMessage(text, { mentions });
}

async function handleOOO(msg, args) {
    if (!msg.fromMe) {
        await msg.reply('❌ Only the account owner can use !ooo.');
        return;
    }
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on') {
        setOOO(true);
        await msg.reply('🏖️ *Out of Office mode ON*\nBot will send the OOO message to all incoming chats.');
    } else if (sub === 'off') {
        setOOO(false);
        await msg.reply('✅ *Out of Office mode OFF*\nBot has returned to normal operation.');
    } else if (sub === 'msg') {
        const text = args.slice(1).join(' ');
        if (!text) { await msg.reply('❌ Usage: !ooo msg <your custom message>'); return; }
        setOOO(getOOOConfig().enabled, text);
        await msg.reply('✅ OOO message updated!');
    } else if (sub === 'status') {
        const cfg = getOOOConfig();
        await msg.reply(`🏖️ *OOO Status:* ${cfg.enabled ? 'ON' : 'OFF'}\n\n*Message:*\n${cfg.message}`);
    } else {
        await msg.reply('Usage: !ooo on | !ooo off | !ooo msg <text> | !ooo status');
    }
}

async function handlePromo(msg, args) {
    if (!msg.fromMe) {
        await msg.reply('❌ Only the account owner can use !promo.');
        return;
    }
    const sub = (args[0] || '').toLowerCase();
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    if (sub === 'list' || !sub) {
        const list = getAllPromos();
        if (!list.length) { await msg.reply('📣 No promos yet. Use !promo add to create one.'); return; }
        const lines = list.map((p, i) => {
            const dayLabel = p.day === -1 ? 'Daily' : (days[p.day] || `Day${p.day}`);
            const time = `${String(p.hour).padStart(2,'0')}:${String(p.minute).padStart(2,'0')}`;
            return `${i+1}. [${p.enabled?'ON':'OFF'}] *${p.name}*\n   🕒 ${dayLabel} @ ${time}\n   ID: ${p.id}`;
        });
        await msg.reply(`📣 *Promo Blasts (${list.length})*\n\n` + lines.join('\n\n'));

    } else if (sub === 'add') {
        // !promo add <day(-1-6)> <HH:MM> <name> | <message>
        // e.g. !promo add 5 17:00 Friday Sale | Get 20% off everything today!
        const rest = args.slice(1).join(' ');
        const parts = rest.split('|');
        if (parts.length < 2) {
            await msg.reply('❌ Usage: !promo add <day> <HH:MM> <name> | <message>\n\n'
                + 'day: -1=daily, 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat\n'
                + 'Example: !promo add 5 17:00 Friday Sale | Get 20% off today!');
            return;
        }
        const [daytimeAndName, ...msgParts] = parts;
        const tokens = daytimeAndName.trim().split(/\s+/);
        const day    = parseInt(tokens[0]);
        const [hStr, mStr] = (tokens[1] || '9:00').split(':');
        const hour   = parseInt(hStr);
        const minute = parseInt(mStr || '0');
        const name   = tokens.slice(2).join(' ').trim() || 'Promo';
        const message = msgParts.join('|').trim();
        if (isNaN(day) || isNaN(hour)) {
            await msg.reply('❌ Invalid day or time. Example: !promo add 5 17:00 Friday Sale | Message here');
            return;
        }
        const id = addPromo({ name, message, day, hour, minute });
        await msg.reply(`✅ Promo "${name}" added (ID: ${id}).\nUse !promo on ${id} to enable it.`);

    } else if (sub === 'on' || sub === 'off') {
        const id = args[1];
        if (!id) { await msg.reply(`❌ Usage: !promo ${sub} <id>`); return; }
        const ok = updatePromo(id, { enabled: sub === 'on' });
        await msg.reply(ok ? `✅ Promo ${sub.toUpperCase()}.` : '❌ Promo not found.');

    } else if (sub === 'del' || sub === 'delete') {
        const id = args[1];
        if (!id) { await msg.reply('❌ Usage: !promo del <id>'); return; }
        deletePromo(id);
        await msg.reply('✅ Promo deleted.');

    } else {
        await msg.reply('Usage: !promo list | !promo add | !promo on/off <id> | !promo del <id>');
    }
}

async function handleBroadcast(client, msg, args) {
    if (!msg.fromMe) {
        await msg.reply('❌ Only the account owner can use !broadcast.');
        return;
    }
    const text = args.join(' ');
    if (!text) {
        await msg.reply('❌ Usage: !broadcast <your message>');
        return;
    }
    const customers = getAllCustomers();
    if (customers.length === 0) {
        await msg.reply('❌ No customers saved yet.');
        return;
    }
    await msg.reply(`📣 Sending broadcast to *${customers.length}* customer(s)...`);
    let sent = 0, failed = 0;
    for (const c of customers) {
        try {
            await client.sendMessage(c.id, text);
            sent++;
            // Small delay to avoid spam detection
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            failed++;
            console.error(`[BROADCAST] Failed to send to ${c.id}:`, e.message);
        }
    }
    await msg.reply(`✅ Broadcast done!\nSent: *${sent}* | Failed: *${failed}*`);
}

async function handleCustomers(msg) {
    if (!msg.fromMe) {
        await msg.reply('❌ Only the account owner can use !customers.');
        return;
    }
    const customers = getAllCustomers();
    if (customers.length === 0) {
        await msg.reply('❌ No customers saved yet.');
        return;
    }
    const lines = customers.map((c, i) => {
        const name = c.name || 'Unknown';
        const date = new Date(c.firstSeen).toLocaleDateString();
        return `${i + 1}. *${name}* — ${c.id.split('@')[0]} (since ${date})`;
    });
    const chunks = [];
    let chunk = `👥 *Customer List (${customers.length})*\n\n`;
    for (const line of lines) {
        if ((chunk + line).length > 3800) {
            chunks.push(chunk);
            chunk = '';
        }
        chunk += line + '\n';
    }
    if (chunk) chunks.push(chunk);
    for (const c of chunks) await msg.reply(c);
}

module.exports = { handleCommand };
