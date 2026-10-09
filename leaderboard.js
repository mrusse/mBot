const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    GatewayIntentBits,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    Events,
    InteractionContextType,
    MessageFlags,
    PermissionFlagsBits,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const { openDatabase, hasMedia, createdAt, usageInBackground } = require('./leaderboard-db');

const CONFIG_PATH = path.join(__dirname, 'leaderboard-config.json');
const DB_PATH = path.join(__dirname, 'leaderboard.db');
const TOP_N = 10;
// /topmessages shows up to this many pages of TOP_N, and its page buttons last this long
const MAX_PAGES = 5;
const PAGE_BUTTONS_MS = 14 * 60_000;
const SCAN_CONCURRENCY = 5;
const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const SCANNED_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const DAY = 24 * 60 * 60 * 1000;
const PERIODS = {
    day: { label: 'Past day', ms: DAY },
    week: { label: 'Past week', ms: 7 * DAY },
    month: { label: 'Past month', ms: 30 * DAY },
    year: { label: 'Past year', ms: 365 * DAY }
};

// Filters shared by /leaderboard and /topmessages
const addFilterOptions = (command) => command
    .addChannelOption(opt => opt
        .setName('channel')
        .setDescription('Only count messages in this channel')
        .addChannelTypes(...SCANNED_CHANNEL_TYPES))
    .addStringOption(opt => opt
        .setName('content')
        .setDescription('Only count messages with media (files, images, link previews, stickers) or text only')
        .addChoices(
            { name: 'All messages', value: 'all' },
            { name: 'Media only', value: 'media' },
            { name: 'Text only', value: 'text' }))
    .addStringOption(opt => opt
        .setName('period')
        .setDescription('Only count messages posted in this time period (default: all time)')
        .addChoices(
            ...Object.entries(PERIODS).map(([value, { label }]) => ({ name: label, value })),
            { name: 'All time', value: 'all' }));

const emojiOption = (description) => (opt) => opt
    .setName('emoji')
    .setDescription(description)
    .setRequired(true)
    .setAutocomplete(true);

const commands = [
    addFilterOptions(new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show who has received or given the most of a reaction')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(emojiOption('The reaction to rank by'))
        .addStringOption(opt => opt
            .setName('type')
            .setDescription('Rank by reactions received (default) or given')
            .addChoices({ name: 'Received', value: 'received' }, { name: 'Given', value: 'given' }))),
    addFilterOptions(new SlashCommandBuilder()
        .setName('topmessages')
        .setDescription('Show the messages with the most of a reaction')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(emojiOption('The reaction to rank messages by'))
        .addUserOption(opt => opt
            .setName('user')
            .setDescription("Only show this person's messages")))
];
const COMMAND_NAMES = commands.map(c => c.name);

// Custom emojis are keyed by lowercase name, so every upload of an emoji with the same name counts together; standard emojis by the character
// label is what autocomplete shows. Standard emojis can be given a name to search by, as "skull:💀".
function parseEmoji(text) {
    const trimmed = text.trim();
    const custom = trimmed.match(/^<?(?:(a):)?:?(\w+):(\d+)>?$/);
    if (custom) {
        const [, animated, name, id] = custom;
        return { key: name.toLowerCase(), name, label: name, display: `<${animated ? 'a' : ''}:${name}:${id}>` };
    }
    const named = trimmed.match(/^(\w+):(.+)$/u);
    if (named) {
        const [, name, emoji] = named;
        return { key: emoji, name, label: `${emoji} ${name}`, display: emoji };
    }
    return { key: trimmed, name: trimmed, label: trimmed, display: trimmed };
}

const formatDuration = (ms) => {
    const mins = Math.round(ms / 60_000);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};

// Repost bots (e.g. one that reposts links with better embeds) post on someone else's behalf. Each config
// entry names the bot (username or user ID) and how its messages start, where {username} marks the
// original poster's username and {displayname} marks text to skip, e.g. "{username} ({displayname}) posted:".
// A bot whose wording has changed over time can list several "formats"; they're tried in order and the
// first one naming a real member wins. A format can be limited to messages posted "before" or "after" a
// date (YYYY-MM-DD) if its wording could be mistaken for another's.
function compileFormat(format) {
    if (!format?.includes('{username}')) throw new Error(`repostBots format "${format}" needs {username}`);
    const pattern = format.split(/(\{username\}|\{displayname\})/).map(part =>
        // Anything but brackets: pre-2023 usernames could contain spaces and quotes
        part === '{username}' ? '(?<username>[^()]+?)'
            : part === '{displayname}' ? '.*?'
                : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp('^' + pattern, 'i');
}

function parseDate(date) {
    if (date === undefined) return null;
    const ms = Date.parse(date);
    if (Number.isNaN(ms)) throw new Error(`repostBots date "${date}" isn't a valid YYYY-MM-DD date`);
    return ms;
}

function parseRepostBots(entries) {
    return entries.map(({ bot, format, formats = format ? [format] : [] }) => {
        if (!bot || !formats.length) throw new Error('each repostBots entry needs a "bot" and a "format" or "formats"');
        return {
            bot: String(bot).toLowerCase(),
            formats: formats.map(f => typeof f === 'string'
                ? { regex: compileFormat(f), before: null, after: null }
                : { regex: compileFormat(f.format), before: parseDate(f.before), after: parseDate(f.after) })
        };
    });
}

// Reads the repost bot setup straight from the file, for app.js to decide its gateway intents at startup
function configuredRepostBots() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).repostBots ?? [];
    } catch {
        return [];
    }
}

module.exports = function setupLeaderboard(client, log) {
    let config = {
        mtime: 0, listed: [], allServerEmojis: false, repostBots: [], usernameMap: new Map(), repostSetup: '[]', lastError: null
    };

    // Re-read the config whenever the file changes, so edits apply without a restart
    function loadConfig() {
        try {
            const { mtimeMs } = fs.statSync(CONFIG_PATH);
            if (mtimeMs !== config.mtime) {
                const { emojis = [], allServerEmojis = false, repostBots = [], usernameMap = {} } =
                    JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                const hasMap = Object.keys(usernameMap).length > 0;
                config = {
                    mtime: mtimeMs,
                    listed: emojis.map(parseEmoji),
                    allServerEmojis: allServerEmojis === true,
                    repostBots: parseRepostBots(repostBots),
                    // Old usernames shown in reposts -> the person's current username or user ID
                    usernameMap: new Map(Object.entries(usernameMap).map(([from, to]) => [from.toLowerCase(), String(to).toLowerCase()])),
                    // Compared with the setup history was last scanned with, to know when to rescan
                    repostSetup: JSON.stringify(hasMap ? { repostBots, usernameMap } : repostBots),
                    lastError: null
                };
                const listed = config.listed.map(e => e.name).join(', ');
                log.info('Leaderboard tracking: ' + (config.allServerEmojis
                    ? 'all server emojis' + (listed ? ` + ${listed}` : '')
                    : listed || '(none)'));
                if (repostBots.length) log.info(`Repost bots: ${repostBots.map(b => b.bot).join(', ')}`);
            }
        } catch (err) {
            if (err.message !== config.lastError) {
                log.error(`Could not read ${path.basename(CONFIG_PATH)}: ${err.message}`);
                config.lastError = err.message;
            }
        }
        return config;
    }

    // The emojis tracked in a server: those listed in the config, plus with allServerEmojis every custom
    // emoji the server has. Listing a server emoji too is harmless; listing one from another server
    // (used with Nitro) still tracks it.
    function getTracked(guild) {
        const { listed, allServerEmojis } = loadConfig();
        if (!allServerEmojis || !guild) return listed;
        const fromServer = [...guild.emojis.cache.values()]
            .filter(e => e.name)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(e => ({ key: e.name.toLowerCase(), name: e.name, label: e.name, display: e.toString() }));
        const tracked = new Map();
        for (const e of [...fromServer, ...listed]) {
            if (!tracked.has(e.key)) tracked.set(e.key, e);
        }
        return [...tracked.values()];
    }

    // Set once the member list is loaded, which matching repost bot usernames needs
    let membersLoaded = false;
    let warnedRestartNeeded = false;
    // Usernames from repost bot messages that matched no member, so each is only logged once
    const unmatchedUsernames = new Set();

    // Who gets credit for a message: its author, or for a repost bot's message the member it names.
    // Returns null for other bots' messages, and for reposts whose poster isn't a member (e.g. they left,
    // or changed username since).
    function creditedAuthor(message) {
        if (!message.author.bot) return message.author.id;
        const names = [message.author.id, message.author.username, message.author.globalName]
            .filter(Boolean).map(n => n.toLowerCase());
        const { repostBots, usernameMap } = loadConfig();
        const bot = repostBots.find(b => names.includes(b.bot));
        if (!bot || !message.content) return null;

        // Try each format that applies to when the message was posted; the first naming a member wins
        const posted = createdAt(message.id);
        const tried = [];
        for (const { regex, before, after } of bot.formats) {
            if ((before !== null && posted >= before) || (after !== null && posted < after)) continue;
            const username = message.content.match(regex)?.groups.username;
            if (!username) continue;
            // Reposts from before Discord's 2023 username change may show an old name#1234 tag
            const name = username.toLowerCase().replace(/#\d{4}$/, '');
            if (!tried.includes(name)) tried.push(name);
            // usernameMap points old usernames at someone's current username or user ID
            const target = usernameMap.get(name) ?? name;
            const member = message.guild?.members.cache.get(target)
                ?? message.guild?.members.cache.find(m => m.user.username.toLowerCase() === target);
            if (member) return member.id;
        }

        const key = tried.join(' / ');
        if (key && !unmatchedUsernames.has(key)) {
            unmatchedUsernames.add(key);
            log.warn(`Repost bot: no member with the username ${tried.map(n => `"${n}"`).join(' or ')}, `
                + 'so their reposts aren\'t counted (add the old name to usernameMap if they changed username)');
        }
        return null;
    }

    const db = openDatabase(DB_PATH);

    let lastTick = Date.now();
    setInterval(() => {
        const stalled = Date.now() - lastTick - 1000;
        if (stalled > 1000) log.warn(`Bot was unresponsive for ${stalled}ms`);
        lastTick = Date.now();
    }, 1000).unref();
    db.resetFailedLookups();

    // ---- Live tracking ----

    async function onReaction(reaction, user, added) {
        const message = reaction.message;
        if (!message.guildId) return;

        try {
            if (user.partial) user = await user.fetch();
            db.upsertUser(user.id, user.bot);
            const isMe = user.id === client.user.id;

            if (db.hasMessage(message.id)) {
                if (added) db.addReactor(message.id, reaction.emoji, user.id, isMe);
                else db.removeReactor(message.id, reaction.emoji, user.id, isMe);
                return;
            }

            // A message with no stored reactions: if it isn't scanned yet the scan will pick it up,
            // otherwise this is its first reaction, so store it now
            if (!added) return;
            const full = message.partial ? await message.fetch() : message;
            const authorId = creditedAuthor(full);
            if (!authorId) return;

            db.transaction(() => {
                db.storeMessage(full, authorId);
                db.markSoleReactor(full.id, reaction.emoji, user.id);
            });

            // If the message already had reactions the bot missed (e.g. while restarting), look up who
            // reacted now rather than waiting behind a long background lookup job
            const tracked = new Set(getTracked(full.guild).map(e => e.key));
            for (const row of db.pendingForMessage(full.id).filter(r => tracked.has(r.match_key))) {
                const users = await withRetry('Who-reacted lookup', () => fetchAllReactors(full.channelId, row));
                db.setReactors(row.message_id, row.emoji, users);
            }
        } catch (err) {
            log.error(`Leaderboard reaction update failed: ${err.message}`);
        }
    }

    // Wraps event handlers so a database or Discord error is logged instead of crashing the bot
    const safely = (name, fn) => (...args) => {
        try {
            fn(...args);
        } catch (err) {
            log.error(`Leaderboard ${name} failed: ${err.message}`);
        }
    };

    client.on(Events.MessageReactionAdd, (reaction, user) => onReaction(reaction, user, true));
    client.on(Events.MessageReactionRemove, (reaction, user) => onReaction(reaction, user, false));
    client.on(Events.MessageReactionRemoveAll, safely('remove all', (message) => db.deleteMessage(message.id)));
    client.on(Events.MessageReactionRemoveEmoji, safely('remove emoji',
        (reaction) => db.removeEmoji(reaction.message.id, reaction.emoji)));

    // Deleted messages drop off the leaderboard
    client.on(Events.MessageDelete, safely('message delete', (message) => db.deleteMessage(message.id)));
    client.on(Events.MessageBulkDelete, safely('bulk delete',
        (messages) => db.transaction(() => messages.forEach(m => db.deleteMessage(m.id)))));

    // Link previews often appear a moment after a message is posted
    client.on(Events.MessageUpdate, safely('message update', (_, message) => {
        if (hasMedia(message) && db.hasMessage(message.id)) db.setMedia(message.id);
    }));

    // Network failures and Discord server errors (5xx) are temporary, e.g. the internet dropping out.
    // Real API errors (4xx) have a status below 500 and are not retried here.
    const isTemporary = (err) => err.status === undefined || err.status >= 500;
    let lastOutageLog = 0;

    // Retries temporary failures with a growing wait (15s up to 5 minutes), so an outage pauses
    // the scan instead of skipping everything it would have checked in the meantime
    async function withRetry(label, fn) {
        let wait = 0;
        while (true) {
            try {
                return await fn();
            } catch (err) {
                if (!isTemporary(err)) throw err;
                wait = Math.min(wait ? wait * 2 : 15_000, 300_000);
                if (Date.now() - lastOutageLog > 60_000) {
                    lastOutageLog = Date.now();
                    log.warn(`${label}: can't reach Discord (${err.message}), retrying in ${wait / 1000}s`);
                }
                await new Promise(resolve => setTimeout(resolve, wait));
            }
        }
    }

    // ---- Phase 1: store every message that has reactions ----

    async function scanMessages(guild, channels) {
        let scanned = 0;
        let ok = true;
        const started = Date.now();
        const queue = [...channels];
        const active = new Set();
        let finished = 0;

        const progress = setInterval(() => {
            log.info(`Message scan: ${guild.name} - ${finished}/${channels.length} channels done, `
                + `scanning ${[...active].map(c => '#' + c.name).join(', ')}, `
                + `${scanned} messages scanned, ${formatDuration(Date.now() - started)} elapsed`);
        }, 60_000);

        async function scanChannel(channel) {
            let { before } = db.channelScan(channel.id);
            while (true) {
                const batch = await withRetry('Message scan',
                    () => channel.messages.fetch({ limit: 100, before: before ?? undefined }));
                scanned += batch.size;
                const done = batch.size < 100;
                before = batch.lastKey() ?? before;
                // Stored together with the position, so a restart never skips or repeats a batch
                const saveStarted = Date.now();
                db.transaction(() => {
                    for (const message of batch.values()) {
                        if (!message.reactions.cache.size) continue;
                        const authorId = creditedAuthor(message);
                        if (authorId) db.storeMessage(message, authorId);
                        // A repost credited under an earlier repost bot setup that no longer matches anyone
                        else if (message.author.bot) db.deleteMessage(message.id);
                    }
                    db.saveChannelScan(channel.id, guild.id, before, done);
                });
                const saveMs = Date.now() - saveStarted;
                if (saveMs > 500) log.warn(`Message scan: saving a batch from #${channel.name} took ${saveMs}ms`);
                if (done) return;
            }
        }

        // Discord rate limits each channel separately, so scanning several at once is much faster
        async function worker() {
            for (let channel = queue.shift(); channel; channel = queue.shift()) {
                active.add(channel);
                try {
                    await scanChannel(channel);
                } catch (err) {
                    ok = false;
                    log.error(`Message scan: failed scanning #${channel.name}: ${err.message}`);
                }
                active.delete(channel);
                finished++;
            }
        }

        try {
            await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        } finally {
            clearInterval(progress);
        }

        log.info(`Message scan: scanned ${scanned} messages in ${channels.length} channel(s) of ${guild.name} `
            + `in ${formatDuration(Date.now() - started)}`);
        return ok;
    }

    // ---- Phase 2: look up who reacted, for tracked emojis ----

    async function fetchAllReactors(channelId, { message_id, emoji, emoji_name }) {
        const isCustom = /^\d+$/.test(emoji);
        const param = encodeURIComponent(isCustom ? `${emoji_name || '_'}:${emoji}` : emoji);
        const users = [];
        let after;
        while (true) {
            const query = new URLSearchParams({ limit: '100' });
            if (after) query.set('after', after);
            const page = await client.rest.get(Routes.channelMessageReaction(channelId, message_id, param), { query });
            users.push(...page);
            if (page.length < 100) return users;
            after = page.at(-1).id;
        }
    }

    async function lookupReactors(guild, keys) {
        const channels = db.pendingChannels(guild.id, keys);
        const total = channels.reduce((sum, c) => sum + c.n, 0);
        if (!total) return;

        const channelName = (id) => '#' + (guild.channels.cache.get(id)?.name ?? id);
        log.info(`Who-reacted lookup: ${total} reactions to check in ${channels.length} channel(s) of ${guild.name}`);

        let done = 0;
        let failed = 0;
        const started = Date.now();
        const queue = channels.map(c => c.channel_id);
        const active = new Set();

        const progress = setInterval(() => {
            const elapsed = Date.now() - started;
            const eta = done ? formatDuration((total - done) * elapsed / done) : 'unknown';
            log.info(`Who-reacted lookup: ${guild.name} - ${done}/${total} (${Math.floor(done / total * 100)}%), `
                + `checking ${[...active].map(channelName).join(', ')}, `
                + `${formatDuration(elapsed)} elapsed, about ${eta} left`);
        }, 60_000);

        async function lookupChannel(channelId) {
            while (true) {
                const rows = db.pendingInChannel(channelId, keys, 100);
                if (!rows.length) return;
                for (const row of rows) {
                    try {
                        db.setReactors(row.message_id, row.emoji, await withRetry('Who-reacted lookup', () => fetchAllReactors(channelId, row)));
                    } catch (err) {
                        // 10008 = Unknown Message: it was deleted
                        if (err.code === 10008) {
                            db.deleteMessage(row.message_id);
                        } else {
                            db.markLookupFailed(row.message_id, row.emoji);
                            if (++failed <= 5) log.warn(`Who-reacted lookup failed in ${channelName(channelId)}: ${err.message}`);
                        }
                    }
                    done++;
                }
            }
        }

        async function worker() {
            for (let channelId = queue.shift(); channelId; channelId = queue.shift()) {
                active.add(channelId);
                await lookupChannel(channelId);
                active.delete(channelId);
            }
        }

        try {
            await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
        } finally {
            clearInterval(progress);
        }

        log.info(`Who-reacted lookup: finished ${done} reactions in ${guild.name} in ${formatDuration(Date.now() - started)}`
            + (failed ? ` (${failed} failed, retried on next start)` : ''));
    }

    // ---- Scan orchestration ----

    let scanRunning = false;
    let scanQueued = false;
    const scanningGuilds = new Set();

    // Scans any readable channel that hasn't been scanned yet (new, or newly readable), then looks up
    // who reacted for any tracked emoji that still needs it
    async function runScans() {
        if (scanRunning) {
            scanQueued = true;
            return;
        }
        scanRunning = true;

        try {
            do {
                scanQueued = false;

                // Bot messages were skipped by earlier scans, so a new or changed repost bot setup needs the
                // message history read again to find their reposts. Stored data is kept.
                const { repostBots, repostSetup } = loadConfig();
                if ((db.getSetting('repostBots') ?? '[]') !== repostSetup) {
                    if (!repostBots.length) {
                        // Nothing new to find. Reposts already stored stay credited.
                        db.setSetting('repostBots', repostSetup);
                    } else if (!membersLoaded) {
                        if (!warnedRestartNeeded) log.warn('Repost bot setup changed: restart the bot to apply it');
                        warnedRestartNeeded = true;
                    } else {
                        log.info('Repost bot setup changed: rescanning message history to find their reposts');
                        db.restartChannelScans();
                        db.setSetting('repostBots', repostSetup);
                    }
                }

                for (const guild of client.guilds.cache.values()) {
                    const textChannels = [...guild.channels.cache.values()]
                        .filter(c => SCANNED_CHANNEL_TYPES.includes(c.type));
                    const readable = textChannels.filter(c => c.permissionsFor(guild.members.me).has(READ_PERMS));
                    const toScan = readable.filter(c => !db.channelScan(c.id).done);

                    if (toScan.length) {
                        const unreadable = textChannels.filter(c => !readable.includes(c));
                        if (unreadable.length) {
                            log.warn(`Message scan: no access to ${unreadable.map(c => '#' + c.name).join(', ')} in ${guild.name}`);
                        }
                        log.info(`Message scan: scanning ${toScan.length} channel(s) of ${guild.name}: `
                            + toScan.map(c => '#' + c.name).join(', '));
                        scanningGuilds.add(guild.id);
                        try {
                            await scanMessages(guild, toScan);
                        } finally {
                            scanningGuilds.delete(guild.id);
                        }
                        // The scan changed how often each emoji is used
                        await refreshUsage();
                    }

                    // Most used emojis are looked up first, so the leaderboards people actually use become
                    // exact soonest
                    const used = emojiUsage(guild.id);
                    const keys = getTracked(guild).map(e => e.key)
                        .sort((a, b) => (used.get(b) ?? 0) - (used.get(a) ?? 0));
                    if (keys.length) await lookupReactors(guild, keys);
                }
            } while (scanQueued);
        } catch (err) {
            log.error(`Scan failed: ${err.message}`);
        } finally {
            scanRunning = false;
        }
    }


    // New emojis in the config, new channels, or permission changes that may let the bot read more channels
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => runScans());
    client.on(Events.GuildCreate, () => runScans());
    // With allServerEmojis, newly uploaded or renamed emojis start being tracked
    client.on(Events.GuildEmojiCreate, () => runScans());
    client.on(Events.GuildEmojiUpdate, () => runScans());
    client.on(Events.ChannelCreate, () => runScans());
    client.on(Events.ChannelUpdate, () => runScans());
    client.on(Events.GuildRoleUpdate, () => runScans());
    client.on(Events.GuildMemberUpdate, (_, member) => {
        if (member.id === client.user.id) runScans();
    });

    client.once(Events.ClientReady, async () => {
        try {
            await client.application.commands.set(commands.map(c => c.toJSON()));
            log.info('Leaderboard slash commands registered');
        } catch (err) {
            log.error(`Failed to register slash commands: ${err.message}`);
        }
        // Matching repost bot usernames to members needs the full member list
        if (loadConfig().repostBots.length) {
            try {
                await Promise.all(client.guilds.cache.map(guild => guild.members.fetch()));
                membersLoaded = true;
            } catch (err) {
                log.error(`Could not load the member list for repost bots: ${err.message}`);
            }
        }
        // Usage totals decide the lookup order, so get them before the first scan
        await refreshUsage();
        runScans();
    });

    // ---- /leaderboard and /topmessages ----

    // How often each emoji is used per server, for ordering autocomplete. Adding up every stored reaction
    // takes a while, so it runs in the background and autocomplete uses the last totals in the meantime.
    const USAGE_REFRESH_MS = 10 * 60_000;
    let usage = { at: 0, byGuild: new Map(), refreshing: null };

    // Returns a promise for callers that need the totals before carrying on
    function refreshUsage() {
        if (usage.refreshing) return usage.refreshing;
        usage.refreshing = usageInBackground(DB_PATH, [...client.guilds.cache.keys()])
            .then(byGuild => { usage = { at: Date.now(), byGuild, refreshing: null }; })
            .catch(err => {
                // Wait the usual interval before trying again rather than retrying on every keystroke
                usage = { ...usage, at: Date.now(), refreshing: null };
                log.error(`Emoji usage count failed: ${err.message}`);
            });
        return usage.refreshing;
    }

    function emojiUsage(guildId) {
        if (Date.now() - usage.at > USAGE_REFRESH_MS) refreshUsage();
        return usage.byGuild.get(guildId) ?? new Map();
    }

    function resolveEmoji(input, tracked) {
        const name = input.trim().replace(/^:|:$/g, '').toLowerCase();
        return tracked.find(e => e.key === parseEmoji(input).key)
            ?? tracked.find(e => e.name.toLowerCase() === name);
    }

    function readFilters(interaction) {
        const channel = interaction.options.getChannel('channel');
        const content = interaction.options.getString('content') ?? 'all';
        const period = PERIODS[interaction.options.getString('period')];
        return {
            channelId: channel?.id ?? null,
            media: content === 'media' ? 1 : content === 'text' ? 0 : null,
            since: period ? Date.now() - period.ms : null,
            labels: [
                channel && `#${channel.name}`,
                content === 'media' && 'Media only',
                content === 'text' && 'Text only',
                period?.label
            ]
        };
    }

    const title = (emoji, name, labels) => [`${emoji.display} ${name}`, ...labels].filter(Boolean).join(' · ');

    function leaderboardEmbed(interaction, emoji, f) {
        const type = interaction.options.getString('type') ?? 'received';
        const ranked = db.leaderboard(type, interaction.guildId, emoji.key, f.channelId, f.media, f.since);
        const top = ranked.slice(0, TOP_N);

        const myIndex = ranked.findIndex(r => r.user_id === interaction.user.id);
        const verb = type === 'given' ? 'given' : 'received';
        const myRank = myIndex === -1
            ? `**Your rank:** none yet, you haven't ${verb} any ${emoji.display}`
            : `**Your rank:** #${myIndex + 1} of ${ranked.length} — ${ranked[myIndex].total}`;

        return new EmbedBuilder()
            .setTitle(title(emoji, 'Leaderboard', [type === 'given' ? 'Given' : 'Received', ...f.labels]))
            .setDescription(top.length
                ? top.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.total}`).join('\n') + '\n\n' + myRank
                : 'No reactions counted yet.');
    }

    // /topmessages replies that can still change page, by message ID: { page, pageCount, render }
    const pagedReplies = new Map();

    async function replyTopMessages(interaction, emoji, f, scanning) {
        const user = interaction.options.getUser('user');
        const userLabel = user && '@' + (interaction.options.getMember('user')?.displayName ?? user.username);
        // Every page is fetched up front, so changing page needs no database work
        const rows = db.topMessages(interaction.guildId, emoji.key, user?.id ?? null, f.channelId, f.media, f.since,
            TOP_N * MAX_PAGES);
        const pageCount = Math.max(1, Math.ceil(rows.length / TOP_N));
        const heading = title(emoji, 'Top Messages', [userLabel, ...f.labels]);

        // The channel name links to the message (keeps lines short enough not to wrap), and <t:time:d>
        // renders as a date in the viewer's own format
        const channelName = (id) => interaction.guild?.channels.cache.get(id)?.name ?? 'message';
        const line = (r, i) => `**${i + 1}.** ${r.total} · <@${r.author_id}> · `
            + `[#${channelName(r.channel_id)}](https://discord.com/channels/${interaction.guildId}/${r.channel_id}/${r.id}) · `
            + `<t:${Math.floor(createdAt(r.id) / 1000)}:d>`;

        // Once paging has ended the reply shows page 1 with no buttons or page number
        const render = (page, ended = false) => {
            const start = page * TOP_N;
            const embed = new EmbedBuilder()
                .setTitle(heading)
                .setDescription(rows.length
                    ? rows.slice(start, start + TOP_N).map((r, i) => line(r, start + i)).join('\n')
                    : 'No messages found.');
            const footer = [
                pageCount > 1 && !ended && `Page ${page + 1}/${pageCount}`,
                scanning && 'Still counting older messages, totals may change.'
            ].filter(Boolean).join(' · ');
            if (footer) embed.setFooter({ text: footer });

            const components = pageCount > 1 && !ended ? [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('topmessages:prev').setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                new ButtonBuilder().setCustomId('topmessages:next').setLabel('Next')
                    .setStyle(ButtonStyle.Secondary).setDisabled(page === pageCount - 1))] : [];

            // Mentions in embeds don't notify anyway, but make sure the reply can never ping
            return { embeds: [embed], components, allowedMentions: { parse: [] } };
        };

        const response = await interaction.reply({ ...render(0), withResponse: true });
        if (pageCount === 1) return;

        const messageId = response.resource.message.id;
        pagedReplies.set(messageId, { page: 0, pageCount, render });
        // The bot can only edit its reply for 15 minutes, so just before that it goes back to page 1
        // and the buttons are removed
        setTimeout(() => {
            pagedReplies.delete(messageId);
            interaction.editReply(render(0, true)).catch(() => {});
        }, PAGE_BUTTONS_MS).unref();
    }

    async function changePage(interaction) {
        const state = pagedReplies.get(interaction.message.id);
        if (!state) {
            // Expired, or from before a restart
            await interaction.update({ components: [] });
            return;
        }
        const step = interaction.customId === 'topmessages:next' ? 1 : -1;
        state.page = Math.min(Math.max(state.page + step, 0), state.pageCount - 1);
        await interaction.update(state.render(state.page));
    }

    client.on(Events.InteractionCreate, async (interaction) => {
        if (interaction.isButton() && interaction.customId.startsWith('topmessages:')) {
            try {
                await changePage(interaction);
            } catch (err) {
                log.error(`/topmessages page change failed: ${err.message}`);
            }
            return;
        }

        if (!COMMAND_NAMES.includes(interaction.commandName)) return;
        try {
            if (interaction.isAutocomplete()) {
                const typed = interaction.options.getFocused().replaceAll(':', '').trim().toLowerCase();
                // Only 25 suggestions fit: names starting with what was typed first, then the most used
                const usage = emojiUsage(interaction.guildId);
                const startsWith = (e) => e.name.toLowerCase().startsWith(typed) ? 0 : 1;
                const choices = getTracked(interaction.guild)
                    .filter(e => e.name.toLowerCase().includes(typed) || e.key.includes(typed))
                    .sort((a, b) => startsWith(a) - startsWith(b) || (usage.get(b.key) ?? 0) - (usage.get(a.key) ?? 0))
                    .slice(0, 25)
                    .map(e => ({ name: e.label, value: e.key }));
                await interaction.respond(choices);
                return;
            }

            if (!interaction.isChatInputCommand()) return;

            const tracked = getTracked(interaction.guild);
            const emoji = resolveEmoji(interaction.options.getString('emoji'), tracked);
            if (!emoji) {
                // Keep the reply under Discord's message length limit when every server emoji is tracked
                const SHOWN = 40;
                const list = tracked.slice(0, SHOWN).map(e => e.display).join(' ') || '(none configured)';
                const more = tracked.length > SHOWN ? ` and ${tracked.length - SHOWN} more` : '';
                await interaction.reply({
                    content: `That emoji isn't tracked. Tracked emojis: ${list}${more}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const filters = readFilters(interaction);
            const scanning = scanningGuilds.has(interaction.guildId) || db.hasPending(interaction.guildId, emoji.key);

            if (interaction.commandName === 'topmessages') {
                await replyTopMessages(interaction, emoji, filters, scanning);
                return;
            }

            const embed = leaderboardEmbed(interaction, emoji, filters);
            if (scanning) embed.setFooter({ text: 'Still counting older messages, totals may change.' });

            // Mentions in embeds don't notify anyway, but make sure the reply can never ping
            await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
            log.error(`/${interaction.commandName} failed: ${err.message}`);
        }
    });
};

// The Server Members intent is only requested when repost bots are configured, since it's a privileged
// intent that has to be switched on in the Discord Developer Portal first
module.exports.extraIntents = () => configuredRepostBots().length ? [GatewayIntentBits.GuildMembers] : [];
