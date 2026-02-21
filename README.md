# WhatsApp Bot

A feature-rich WhatsApp bot built with [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js).

## Features

- QR code login via terminal
- Persistent session (no re-scan after restart)
- Command handler with prefix `!`
- Scheduled daily messages (via cron)
- Group support (tag all, group info)

## Commands

| Command | Description |
|---|---|
| `!ping` | Check if bot is alive |
| `!help` | Show all commands |
| `!info` | Show chat/group info |
| `!joke` | Random joke |
| `!quote` | Inspirational quote |
| `!sticker` | Convert image reply to sticker |
| `!tagall` | Tag all group members |
| `!say <text>` | Make bot say something |

## Setup

1. **Install dependencies**
   ```bash
   set PUPPETEER_SKIP_DOWNLOAD=true
   npm install
   ```

2. **Configure `.env`** (optional)
   ```
   OWNER_NUMBER=1234567890@c.us
   SCHEDULED_GROUP_ID=<group-id>@g.us
   SCHEDULED_MESSAGE=Good morning!
   ```

3. **Start the bot**
   ```bash
   npm start
   ```

4. **Scan the QR code** shown in the terminal with your WhatsApp app:
   - Open WhatsApp → Settings → Linked Devices → Link a Device

## Getting Group/Channel IDs

To find a group ID, send any message in the group and check the terminal — it logs:
```
[MSG] From: 1234567890-123456@g.us | Body: ...
```
Copy that ID and use it in `.env` for `SCHEDULED_GROUP_ID`.

## Notes

- Session is saved in `.wwebjs_auth/` — do not delete it if you want to stay logged in
- Using your personal number carries a small risk of being flagged by WhatsApp; use a secondary number for production bots
