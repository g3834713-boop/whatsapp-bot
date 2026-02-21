# Deploying Multiple Bot Instances on Railway

Each bot instance is a separate Railway service pointing at the same GitHub repo.  
They are **fully isolated** — different phone number, different WhatsApp session, different config, different payment images, different dashboard password.

---

## Prerequisites

- This repo pushed to GitHub
- A [Railway](https://railway.app) account
- One phone number per bot (SIM or WhatsApp Business number)

---

## Deploying the First Bot (or any additional bot)

### 1. Create a new Railway Service

1. Open your Railway project → **+ New** → **GitHub Repo**
2. Select this repository
3. Railway will detect the `Dockerfile` automatically

### 2. Add a Persistent Volume

> Without a volume the WhatsApp session and all config changes are lost on every redeploy.

1. Click the service → **Volumes** tab → **Add Volume**
2. Mount path: `/app/data`
3. Click **Create** — Railway provisions the volume immediately

### 3. Set Environment Variables

Click the service → **Variables** tab → add the following:

| Variable | Example | Notes |
|---|---|---|
| `CLIENT_ID` | `bot-client1` | **Must be unique per service.** Used to namespace the WhatsApp session. |
| `DASHBOARD_PASSWORD` | `supersecret` | Protects the dashboard. Omit to leave it open (not recommended). |
| `BOT_TIMEZONE` | `Africa/Johannesburg` | **Required for correct working-hours checks.** Railway runs UTC — without this the bot thinks it's always UTC time and may send "we're closed" messages when you're actually open. Use any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `DATA_DIR` | `/app/data` | Should match your volume mount path. |
| `BOT_PREFIX` | `!` | Command prefix. Default is `!`. |
| `PORT` | *(leave unset)* | Railway injects this automatically. |

> **Every service must have a different `CLIENT_ID`.**  
> If two services share the same `CLIENT_ID` on the same volume, their sessions will collide.  
> Since each service has its own isolated volume this is just a precaution, but still good practice.

### 4. Deploy

Railway auto-deploys when variables are saved. Watch the build logs — a successful first deploy looks like:

```
[ENTRYPOINT] First run — copying default config to /app/data/config
[ENTRYPOINT] First run — copying default images to /app/data/images
[ENTRYPOINT] Linked /app/config -> /app/data/config
[ENTRYPOINT] Linked /app/images -> /app/data/images
[ENTRYPOINT] Cleared stale Chromium lock files
[DASHBOARD] Open http://localhost:8080 in your browser
[BOT] Starting WhatsApp bot...
```

### 5. Scan the QR Code

1. Open the service's public URL (Railway **Settings** → **Domains** → Generate Domain)
2. Log in with your `DASHBOARD_PASSWORD`
3. The dashboard shows a QR code on the home screen
4. On the phone for this bot: **WhatsApp → Settings → Linked Devices → Link a Device** → scan

The bot connects and the dashboard shows **Connected ✅**.

---

## Per-Bot Customisation (all via the Dashboard)

Everything below is stored on each bot's own volume — changes on Bot 1 never affect Bot 2.

| Feature | Where to change |
|---|---|
| Business name & menu text | Auto-Reply page → Save |
| Payment images (pay.png / ship.png) | Auto-Reply page → Upload New |
| Scheduled messages | Schedules page |
| Out-of-office message | OOO page |
| Promo blasts & re-engagement | Campaigns page |

---

## Deploying a Second (or Third) Bot

Repeat **all steps above** on a new service in the same (or a different) Railway project.  
The only things that must differ between services:

- **`CLIENT_ID`** — unique string, e.g. `bot-client2`
- **`DASHBOARD_PASSWORD`** — each team gets their own password
- **Volume** — each service must have its own volume at `/app/data`
- **Phone number** — each bot links to a different WhatsApp number

Everything else (Dockerfile, source code, repo) is identical — no code changes needed.

---

## Updating All Bots

Push a code change to `main` on GitHub.  
Railway redeploys **each service** automatically from the same repo.  
Config and session data on each volume are never touched during a code redeploy.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| **Bot is live but not responding** | Almost always a timezone issue. Set `BOT_TIMEZONE` (e.g. `Africa/Johannesburg`) in Railway Variables — without it the bot uses UTC and thinks it's outside working hours. |
| Bot crashes immediately with `SingletonLock` error | The entrypoint clears locks on every start. If it persists, delete `.wwebjs_auth/` folder from the volume via Railway's volume browser and restart. |
| QR code never appears | Check build logs. Usually means `CHROMIUM_PATH` is wrong or Chromium dependencies are missing — the `node:18-bookworm-slim` base image includes them all. |
| Dashboard login fails | Double-check `DASHBOARD_PASSWORD` env var in Railway. Changing it invalidates all existing browser sessions (users must log in again). |
| `401 Unauthorized` on all API calls after password change | Clear `localStorage` in the browser (`localStorage.removeItem('dash_token')`) or open the dashboard in an incognito window. |
| Session lost after redeploy | Ensure the volume is mounted at `/app/data` and `DATA_DIR=/app/data` is set. |
