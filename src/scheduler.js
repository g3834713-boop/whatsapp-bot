const { MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

// 1x1 transparent PNG — used to send "text-only" messages to newsletter channels
// (WhatsApp channels only accept media sends; plain text throws internal errors)
const PIXEL_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PIXEL_MEDIA = new MessageMedia('image/png', PIXEL_PNG_B64, 'pixel.png');

function loadSchedules() {
    const filePath = path.join(__dirname, '..', 'config', 'schedules.json');
    if (!fs.existsSync(filePath)) {
        console.warn('[SCHEDULER] config/schedules.json not found.');
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error('[SCHEDULER] Failed to parse schedules.json:', err.message);
        return [];
    }
}

/** Resolve local file or URL to MessageMedia */
async function resolveMedia(imageFile) {
    if (!imageFile) return null;
    const localPath = path.join(__dirname, '..', 'images', imageFile);
    if (fs.existsSync(localPath)) {
        return MessageMedia.fromFilePath(localPath);
    }
    const url = imageFile.includes('picsum') ? `${imageFile}?v=${Date.now()}` : imageFile;
    return await MessageMedia.fromUrl(url, { unsafeMime: true });
}

/** Wait helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Low-level send. Newsletter channels MUST use sendSeen:false to avoid internal API crash. */
async function safeSend(client, chatId, content, options = {}) {
    const isNewsletter = chatId.endsWith('@newsletter');

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            if (isNewsletter) {
                // Newsletter channels: use client.sendMessage with sendSeen: false
                await client.sendMessage(chatId, content, { ...options, sendSeen: false });
            } else {
                // Regular chats/groups
                const chat = await client.getChatById(chatId);
                await chat.sendMessage(content, options);
            }
            return; // success
        } catch (err) {
            if (attempt < 3) {
                console.warn(`[SCHEDULER] Send failed (attempt ${attempt}/3): ${err.message} — retrying in 5s...`);
                await sleep(5000);
            } else {
                throw err;
            }
        }
    }
}

/** Send one step — supports text, image, text+image, multi-image */
async function sendStep(client, chatId, step) {
    if (!step) return;

    const isNewsletter = chatId.endsWith('@newsletter');

    if (step.type === 'text') {
        await safeSend(client, chatId, step.message);

    } else if (step.type === 'image') {
        const media = await resolveMedia(step.image);
        await safeSend(client, chatId, media, { caption: step.caption || '' });

    } else if (step.type === 'text+image') {
        const media = await resolveMedia(step.image);
        // For newsletters: put text as the image caption instead of a separate send
        if (isNewsletter) {
            await safeSend(client, chatId, media, { caption: step.message || step.caption || '' });
        } else {
            await safeSend(client, chatId, step.message);
            await safeSend(client, chatId, media, { caption: step.caption || '' });
        }

    } else if (step.type === 'multi-image') {
        const images = step.images || [];
        if (images.length === 0) return;

        if (isNewsletter) {
            // Put the text message as caption on the FIRST image; remaining images sent plain
            for (let i = 0; i < images.length; i++) {
                const media = await resolveMedia(images[i].file);
                const caption = i === 0 ? (step.message || images[i].caption || '') : (images[i].caption || '');
                await safeSend(client, chatId, media, { caption });
            }
        } else {
            if (step.message) await safeSend(client, chatId, step.message);
            for (const img of images) {
                const media = await resolveMedia(img.file);
                await safeSend(client, chatId, media, { caption: img.caption || '' });
            }
        }
    }
}

/** Run tasks sequentially — post task, wait duration, post completion, next task */
async function runSequentialTasks(client, schedule) {
    const { chatId, name, tasks } = schedule;
    console.log(`[SCHEDULER] ✅ "${name}" — sequential mode, ${tasks.length} tasks`);

    // Give WhatsApp Web time to fully load chats/channels before first send
    const WARMUP_MS = 15000;
    let delayMs = WARMUP_MS;

    for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskNum = i + 1;
        const startDelay = delayMs;

        // Post task start
        setTimeout(async () => {
            console.log(`[SCHEDULER] "${name}" → Task ${taskNum}/${tasks.length} posting...`);
            try {
                await sendStep(client, chatId, task.start);
                console.log(`[SCHEDULER] "${name}" → Task ${taskNum} posted ✓`);
            } catch (err) {
                console.error(`[SCHEDULER] "${name}" → Task ${taskNum} FAILED:`, err.message);
            }
        }, startDelay);

        // Advance delay by task duration
        delayMs += (task.durationMinutes || 0) * 60 * 1000;

        // Post completion message + immediately trigger next task (handled by next loop iteration's setTimeout)
        if (task.completion) {
            const completionDelay = delayMs;
            setTimeout(async () => {
                console.log(`[SCHEDULER] "${name}" → Task ${taskNum} completion`);
                try {
                    await sendStep(client, chatId, task.completion);
                } catch (err) {
                    console.error(`[SCHEDULER] "${name}" → Task ${taskNum} completion FAILED:`, err.message);
                }
            }, completionDelay);
        }
    }

    const totalMin = Math.round(delayMs / 60000);
    console.log(`[SCHEDULER] "${name}" → All ${tasks.length} tasks scheduled. Total: ~${totalMin} min`);
}

/** Run rotating interval schedule */
function runRotatingSchedule(client, schedule) {
    const intervalMs = (schedule.intervalSeconds || 60) * 1000;
    let taskIndex = 0;
    console.log(`[SCHEDULER] ✅ "${schedule.name}" — rotating every ${schedule.intervalSeconds}s, ${schedule.tasks.length} task(s)`);

    setInterval(async () => {
        const task = schedule.tasks[taskIndex % schedule.tasks.length];
        taskIndex++;
        console.log(`[SCHEDULER] "${schedule.name}" → task #${taskIndex} (${task.type})`);
        try {
            await sendStep(client, schedule.chatId, task);
            console.log(`[SCHEDULER] "${schedule.name}" → sent ✓`);
        } catch (err) {
            console.error(`[SCHEDULER] "${schedule.name}" → failed:`, err.message);
        }
    }, intervalMs);
}

function startScheduler(client) {
    const schedules = loadSchedules();
    if (schedules.length === 0) {
        console.log('[SCHEDULER] No schedules configured.');
        return;
    }
    for (const schedule of schedules) {
        if (!schedule.enabled) {
            console.log(`[SCHEDULER] Skipping disabled: "${schedule.name}"`);
            continue;
        }
        if (!schedule.chatId) {
            console.warn(`[SCHEDULER] "${schedule.name}" missing chatId — skipping.`);
            continue;
        }
        if (schedule.mode === 'sequential') {
            runSequentialTasks(client, schedule);
        } else {
            runRotatingSchedule(client, schedule);
        }
    }
}

module.exports = { startScheduler };
