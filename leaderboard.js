const fs = require('fs');
const path = require('path');
const {
    ActionRowBuilder,
    AttachmentBuilder,
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
const {
    openDatabase, hasMedia, createdAt, usageInBackground, profileInBackground,
    votesByMonthInBackground, votesByAuthorInBackground, votesByMessageInBackground,
    votingHabitsInBackground, emojiByMonthInBackground
} = require('./leaderboard-db');
const { renderLineChart, emojiIconUrl } = require('./leaderboard-chart');
const {
    wilson, spanOf, alignToMonths, runningTotal, rankHaters, parseMonth, trimMonths, ratioSeries
} = require('./leaderboard-stats');

const CONFIG_PATH = path.join(__dirname, 'leaderboard-config.json');
const DB_PATH = path.join(__dirname, 'leaderboard.db');
const TOP_N = 10;
// /topmessages shows up to this many pages of TOP_N, and its page buttons last this long
const MAX_PAGES = 5;
const PAGE_BUTTONS_MS = 14 * 60_000;
const SCAN_CONCURRENCY = 5;
const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const SCANNED_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const MIN_VOTES = 20;          // votes someone needs before /votes ranks their approval or habits
const EMOJI_GRAPH_MAX = 10;    // lines on /emojigraph, as many as the chart palette has colours for
const HABITS_REFRESH_MS = 10 * 60_000;

const DAY = 24 * 60 * 60 * 1000;
const PERIODS = {
    day: { label: 'Past day', ms: DAY },
    week: { label: 'Past week', ms: 7 * DAY },
    month: { label: 'Past month', ms: 30 * DAY },
    year: { label: 'Past year', ms: 365 * DAY }
};

// Filters shared by /leaderboard and /topmessages. The charts only offer periods long enough to span
// several monthly points
const CHART_PERIODS = ['year'];

// A window for the charts, by month, on top of the filters above
const addWindowOptions = (command) => command
    .addStringOption(opt => opt
        .setName('from')
        .setDescription('First month to include, like 2024 or 2024-03'))
    .addStringOption(opt => opt
        .setName('to')
        .setDescription('Last month to include, like 2025 or 2025-06'));
const addFilterOptions = (command, periods = Object.keys(PERIODS)) => command
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
            ...periods.map(value => ({ name: PERIODS[value].label, value })),
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
            .setDescription("Only show this person's messages"))),
    addFilterOptions(new SlashCommandBuilder()
        .setName('profile')
        .setDescription("Show someone's reaction stats")
        .setContexts(InteractionContextType.Guild)
        .addUserOption(opt => opt
            .setName('user')
            .setDescription('Whose profile to show (default: you)'))),
    addWindowOptions(addFilterOptions(new SlashCommandBuilder()
        .setName('votegraph')
        .setDescription('Chart upvotes, downvotes or score over time, by when the messages were posted')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(opt => opt
            .setName('mode')
            .setDescription('What to chart (default: upvotes)')
            .addChoices(
                { name: 'Upvotes', value: 'up' },
                { name: 'Downvotes', value: 'down' },
                { name: 'Score (upvotes - downvotes)', value: 'score' }))
        .addStringOption(opt => opt
            .setName('per')
            .setDescription('Average per message instead of a total (default: no)')
            .addChoices(
                { name: 'Per message with a reaction', value: 'messages' },
                { name: 'Per message with an upvote or downvote', value: 'voted' }))
        .addBooleanOption(opt => opt
            .setName('cumulative')
            .setDescription('Running total instead of per month (default: yes)'))
        .addUserOption(opt => opt
            .setName('user')
            .setDescription("Only count this person's messages")), CHART_PERIODS)),
    addWindowOptions(addFilterOptions(new SlashCommandBuilder()
        .setName('emojigraph')
        .setDescription('Chart how often the most used emojis are used over time')
        .setContexts(InteractionContextType.Guild)
        .addUserOption(opt => opt
            .setName('user')
            .setDescription('Chart this person instead of the whole server'))
        .addStringOption(opt => opt
            .setName('type')
            .setDescription("With a user: emojis they gave (default) or received")
            .addChoices({ name: 'Given', value: 'given' }, { name: 'Received', value: 'received' }))
        .addIntegerOption(opt => opt
            .setName('count')
            .setDescription(`How many emojis to chart (default: ${EMOJI_GRAPH_MAX})`)
            .setMinValue(1)
            .setMaxValue(EMOJI_GRAPH_MAX))
        .addBooleanOption(opt => opt
            .setName('cumulative')
            .setDescription('Running total instead of per month (default: no)')), CHART_PERIODS)),
    addFilterOptions(new SlashCommandBuilder()
        .setName('votes')
        .setDescription('Rank people and messages by upvotes and downvotes')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(opt => opt
            .setName('view')
            .setDescription('What to rank')
            .setRequired(true)
            .addChoices(
                { name: 'Net score received', value: 'net' },
                { name: 'Approval (best)', value: 'approval' },
                { name: 'Harshest voters', value: 'harshest' },
                { name: 'Kindest voters', value: 'kindest' },
                { name: 'Best messages by net score', value: 'bestmessages' },
                { name: 'Worst messages by net score', value: 'worstmessages' })))
];
const COMMAND_NAMES = commands.map(c => c.name);

// Custom emojis are keyed by lowercase name, so every upload of an emoji with the same name counts together; standard emojis by the character
// label is what autocomplete shows. Standard emojis can be given a name to search by, as "skull:💀".
function parseEmoji(text) {
    const trimmed = text.trim();
    const custom = trimmed.match(/^<?(?:(a):)?:?(\w+):(\d+)>?$/);
    if (custom) {
        const [, animated, name, id] = custom;
        return { key: name.toLowerCase(), name, id, label: name, display: `<${animated ? 'a' : ''}:${name}:${id}>` };
    }
    const named = trimmed.match(/^(\w+):(.+)$/u);
    if (named) {
        const [, name, emoji] = named;
        return { key: emoji, name, id: null, label: `${emoji} ${name}`, display: emoji };
    }
    return { key: trimmed, name: trimmed, id: null, label: trimmed, display: trimmed };
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

// The upvote and downvote emojis, each a custom emoji given as name:id. Unlike the leaderboards they match
// the exact emoji, not every upload sharing its name, because other servers have emojis with the same names
function parseVoteEmojis(entry) {
    if (!entry) return null;
    const [up, down] = ['up', 'down'].map(side => {
        const emoji = parseEmoji(String(entry[side] ?? ''));
        if (!emoji.id) throw new Error(`voteEmojis "${side}" needs a custom emoji as name:id`);
        return emoji;
    });
    return { up, down };
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
        mtime: 0, listed: [], allServerEmojis: false, repostBots: [], usernameMap: new Map(), repostSetup: '[]', voteEmojis: null, lastError: null
    };

    // Re-read the config whenever the file changes, so edits apply without a restart
    function loadConfig() {
        try {
            const { mtimeMs } = fs.statSync(CONFIG_PATH);
            if (mtimeMs !== config.mtime) {
                const { emojis = [], allServerEmojis = false, repostBots = [], usernameMap = {}, voteEmojis = null } =
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
                    voteEmojis: parseVoteEmojis(voteEmojis),
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
        // The first /profile or /votes shouldn't pay for adding up every vote
        const vote = loadConfig().voteEmojis;
        if (vote) {
            for (const guild of client.guilds.cache.values()) {
                votingHabits(guild.id, { channelId: null, media: null, since: null }, vote)
                    .catch(err => log.error(`Voting habits lookup failed: ${err.message}`));
            }
        }
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

    async function replyProfile(interaction) {
        // A profile adds up everything one person has received and given, which can take a few seconds on
        // a big server. Discord drops replies after 3 seconds unless told the bot is working on it.
        await interaction.deferReply();
        const user = interaction.options.getUser('user') ?? interaction.user;
        const member = interaction.options.getMember('user') ?? (user.id === interaction.user.id ? interaction.member : null);
        const name = member?.displayName ?? user.globalName ?? user.username;
        const f = readFilters(interaction);
        const tracked = getTracked(interaction.guild);
        const keys = tracked.map(e => e.key);
        const display = new Map(tracked.map(e => [e.key, e.display]));
        // If the habits lookup fails the profile still shows, minus the biggest hater
        const vote = loadConfig().voteEmojis;
        const [{ received, given, fans }, habits] = await Promise.all([
            profileInBackground(DB_PATH, interaction.guildId, user.id, keys, f.channelId, f.media, f.since, vote),
            (vote ? votingHabits(interaction.guildId, f, vote) : Promise.resolve([]))
                .then(rows => new Map(rows.map(r => [r.user_id, r])))
                .catch(err => {
                    log.error(`Voting habits lookup failed: ${err.message}`);
                    return new Map();
                })
        ]);

        // received has one row per message per emoji, so add them up three ways
        const byEmoji = new Map();
        const byMessage = new Map();
        const byChannel = new Map();
        for (const r of received) {
            byEmoji.set(r.match_key, (byEmoji.get(r.match_key) ?? 0) + r.total);
            const msg = byMessage.get(r.id) ?? { channelId: r.channel_id, total: 0 };
            msg.total += r.total;
            byMessage.set(r.id, msg);
            byChannel.set(r.channel_id, (byChannel.get(r.channel_id) ?? 0) + r.total);
        }
        const sum = (values) => [...values].reduce((a, b) => a + b, 0);
        const receivedTotal = sum(byEmoji.values());
        const givenTotal = sum(given.map(g => g.total));
        const most = (map) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
        const n = (x) => x.toLocaleString('en-US');

        const topEmojis = (pairs) => pairs.slice(0, 5).map(([key, total]) => `${display.get(key) ?? key} ${n(total)}`).join(' · ');
        const receivedSorted = [...byEmoji].sort((a, b) => b[1] - a[1]);
        const givenSorted = given.map(g => [g.match_key, g.total]);

        const embed = new EmbedBuilder()
            .setTitle(title({ display: '👤' }, `Profile · ${name}`, f.labels))
            .setThumbnail(user.displayAvatarURL({ size: 128 }))
            .addFields(
                { name: 'Received', value: receivedTotal ? `**${n(receivedTotal)}**\n${topEmojis(receivedSorted)}` : 'None yet', inline: true },
                { name: 'Given', value: givenTotal ? `**${n(givenTotal)}**\n${topEmojis(givenSorted)}` : 'None yet', inline: true }
            );

        if (receivedTotal && givenTotal) {
            embed.addFields({ name: 'Ratio', value: `Gives ${(givenTotal / receivedTotal).toFixed(2)} for every 1 received` });
        }
        const topMessage = most(new Map([...byMessage].map(([id, m]) => [id, m.total])));
        if (topMessage) {
            const [id, total] = topMessage;
            const channelId = byMessage.get(id).channelId;
            const channelName = interaction.guild?.channels.cache.get(channelId)?.name ?? 'message';
            embed.addFields({
                name: 'Most reacted message',
                value: `${n(total)} · [#${channelName}](https://discord.com/channels/${interaction.guildId}/${channelId}/${id}) · `
                    + `<t:${Math.floor(createdAt(id) / 1000)}:d>`
            });
        }
        const topChannel = most(byChannel);
        if (topChannel) {
            embed.addFields({ name: 'Top channel', value: `<#${topChannel[0]}> · ${n(topChannel[1])} received` });
        }

        // Who votes on this person's messages
        const topVoter = (isUp) => fans.filter(r => !!r.is_up === isUp).sort((a, b) => b.total - a.total)[0];
        const fan = topVoter(true);
        const downvoter = topVoter(false);
        const hater = rankHaters(fans, habits)[0];
        if (fan) embed.addFields({ name: 'Biggest fan', value: `<@${fan.user_id}> · ${n(fan.total)} upvotes`, inline: true });
        if (downvoter) {
            embed.addFields({ name: 'Most downvotes from', value: `<@${downvoter.user_id}> · ${n(downvoter.total)}`, inline: true });
        }
        if (hater && hater.lift > 1) {
            embed.addFields({
                name: 'Biggest hater',
                value: `<@${hater.userId}> · ${n(hater.down)} downvotes, ${hater.lift.toFixed(1)}x their usual rate`,
                inline: true
            });
        }

        if (scanningGuilds.has(interaction.guildId) || db.hasPendingAny(interaction.guildId, keys)) {
            embed.setFooter({ text: 'Still counting older messages, totals may change.' });
        }
        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    }

    // ---- vote charts and rankings ----

    // Everyone's up and down votes given, which takes a few seconds to add up. Kept for a while per filter
    // combination, but not with a period filter: its start moves with the clock, so it would never be reused
    const habitsCache = new Map();

    function votingHabits(guildId, f, vote) {
        const run = () => votingHabitsInBackground(DB_PATH, guildId, vote, f.channelId, f.media, f.since);
        if (f.since !== null) return run();
        const key = `${guildId}|${vote.up.id}|${vote.down.id}|${f.channelId}|${f.media}`;
        const hit = habitsCache.get(key);
        if (hit && Date.now() - hit.at < HABITS_REFRESH_MS) return hit.promise;
        const promise = run().catch(err => {
            habitsCache.delete(key);
            throw err;
        });
        habitsCache.set(key, { at: Date.now(), promise });
        return promise;
    }

    const nameOf = (interaction, user) =>
        interaction.options.getMember('user')?.displayName ?? user.globalName ?? user.username;

    // The vote emojis from the config. Replies and returns null when they are not set up, so callers return
    async function requireVotes(interaction) {
        const vote = loadConfig().voteEmojis;
        if (!vote) {
            await interaction.reply({
                content: 'The vote emojis are not set up. Add "voteEmojis" to the leaderboard config.',
                flags: MessageFlags.Ephemeral
            });
        }
        return vote;
    }

    const isScanning = (guildId, keys) => scanningGuilds.has(guildId) || db.hasPendingAny(guildId, keys);

    // Votes are placed on messages, so charts are by when the message was posted, not when it was voted on
    async function sendChart(interaction, png, heading, extraFooter, keys) {
        const embed = new EmbedBuilder()
            .setTitle(heading)
            .setImage('attachment://chart.png')
            .setFooter({
                text: [
                    'By when each message was posted, not when it was voted on',
                    extraFooter,
                    isScanning(interaction.guildId, keys) && 'Still counting older messages, totals may change.'
                ].filter(Boolean).join(' · ')
            });
        await interaction.editReply({
            embeds: [embed],
            files: [new AttachmentBuilder(png, { name: 'chart.png' })],
            allowedMentions: { parse: [] }
        });
    }

    // The from and to options as YYYY-MM, or replies and returns null when one isn't a date or they are
    // the wrong way round
    async function readWindow(interaction) {
        const given = (name) => interaction.options.getString(name);
        const from = given('from') === null ? null : parseMonth(given('from'), false);
        const to = given('to') === null ? null : parseMonth(given('to'), true);
        const bad = (given('from') !== null && !from) || (given('to') !== null && !to) || (from && to && from > to);
        if (bad) {
            await interaction.reply({
                content: 'Dates need to look like 2024 or 2024-03, and "from" cannot be after "to".',
                flags: MessageFlags.Ephemeral
            });
            return null;
        }
        return { from, to, label: from || to ? `${from ?? 'start'} to ${to ?? 'now'}` : null };
    }

    // What "per" divides by, as it reads in a title
    const PER_LABELS = { messages: 'message with a reaction', voted: 'message with a vote' };

    const VOTE_MODES = {
        up: { label: 'Upvotes', pick: r => r.up },
        down: { label: 'Downvotes', pick: r => r.down },
        score: { label: 'Score', pick: r => r.up - r.down }
    };

    async function replyVoteGraph(interaction) {
        const vote = await requireVotes(interaction);
        if (!vote) return;
        const window = await readWindow(interaction);
        if (!window) return;
        await interaction.deferReply();
        const modeKey = interaction.options.getString('mode') ?? 'up';
        const mode = VOTE_MODES[modeKey];
        const per = interaction.options.getString('per');
        const cumulative = interaction.options.getBoolean('cumulative') ?? true;
        const user = interaction.options.getUser('user');
        const f = readFilters(interaction);
        // Cutting the window here, before anything is added up, makes a running total start at zero in it
        const rows = trimMonths(await votesByMonthInBackground(DB_PATH, interaction.guildId, vote, user?.id ?? null,
            f.channelId, f.media, f.since), window.from, window.to);
        const months = spanOf(rows);
        if (!months) {
            await interaction.editReply('No votes found.');
            return;
        }
        const totals = alignToMonths(rows, months, mode.pick);
        // Months can exist only because of the other vote type, which would chart a flat line of zeros
        if (totals.every(v => v === 0)) {
            await interaction.editReply(`No ${mode.label.toLowerCase()} found.`);
            return;
        }
        const divisors = per && alignToMonths(rows, months, r => per === 'voted' ? r.voted : r.messages);
        const values = per ? ratioSeries(totals, divisors, cumulative) : cumulative ? runningTotal(totals) : totals;
        const icon = modeKey === 'score' ? null : emojiIconUrl(vote[modeKey].display);
        const shape = per ? (cumulative ? 'running average' : 'per month') : (cumulative ? 'running total' : 'per month');
        const png = await renderLineChart({
            title: [per ? `${mode.label} per ${PER_LABELS[per]}` : mode.label, shape, user && nameOf(interaction, user),
                window.label, ...f.labels].filter(Boolean).join(' - '),
            labels: months,
            series: [{ label: mode.label, values, iconUrl: icon }]
        });
        // Messages with no reaction aren't stored, so that average is over fewer messages than were sent
        await sendChart(interaction, png, title({ display: '📈' }, 'Votes over time', []),
            per === 'messages' && 'Only messages with a reaction are stored, not every message sent',
            [vote.up.key, vote.down.key]);
    }

    async function replyEmojiGraph(interaction) {
        const window = await readWindow(interaction);
        if (!window) return;
        await interaction.deferReply();
        const user = interaction.options.getUser('user');
        // Without a user it is the server's totals, where given and received are the same reactions
        const given = user ? (interaction.options.getString('type') ?? 'given') === 'given' : false;
        const count = interaction.options.getInteger('count') ?? EMOJI_GRAPH_MAX;
        const cumulative = interaction.options.getBoolean('cumulative') ?? false;
        const f = readFilters(interaction);
        const tracked = getTracked(interaction.guild);
        const byKey = new Map(tracked.map(e => [e.key, e]));

        // Server: the most used emojis by the totals the autocomplete already keeps. A person: their own
        // most used, so every emoji is fetched and the busiest are picked from the totals
        const used = emojiUsage(interaction.guildId);
        const candidates = user ? [...byKey.keys()]
            : [...byKey.keys()].sort((a, b) => (used.get(b) ?? 0) - (used.get(a) ?? 0)).slice(0, count);
        const rows = trimMonths(await emojiByMonthInBackground(DB_PATH, interaction.guildId, candidates, given,
            user?.id ?? null, f.channelId, f.media, f.since, loadConfig().voteEmojis), window.from, window.to);

        const totals = new Map();
        for (const r of rows) totals.set(r.match_key, (totals.get(r.match_key) ?? 0) + r.total);
        const keys = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a)).slice(0, count);
        const months = spanOf(rows);
        if (!months) {
            await interaction.editReply('No reactions found.');
            return;
        }
        const series = keys.map(key => {
            const values = alignToMonths(rows.filter(r => r.match_key === key), months, r => r.total);
            const emoji = byKey.get(key);
            return {
                label: emoji?.name ?? key,
                values: cumulative ? runningTotal(values) : values,
                iconUrl: emojiIconUrl(emoji?.display)
            };
        });
        const who = user ? `${nameOf(interaction, user)} (${given ? 'given' : 'received'})` : 'Server';
        const png = await renderLineChart({
            title: ['Emoji use', cumulative ? 'running total' : 'per month', who, window.label, ...f.labels]
                .filter(Boolean).join(' - '),
            labels: months,
            series
        });
        await sendChart(interaction, png, title({ display: '📊' }, 'Emoji over time', []), null, keys);
    }

    const per1000 = (down, votes) => (down / votes * 1000).toFixed(1);

    async function replyVotes(interaction) {
        const vote = await requireVotes(interaction);
        if (!vote) return;
        await interaction.deferReply();
        const view = interaction.options.getString('view');
        const f = readFilters(interaction);
        const n = (x) => x.toLocaleString('en-US');
        const keys = [vote.up.key, vote.down.key];
        const sign = (x) => x > 0 ? `+${n(x)}` : n(x);
        let heading;
        let lines;
        let footer = null;
        // Approval and both voter rankings are ordered by the Wilson bound
        const explainer = ['approval', 'harshest', 'kindest'].includes(view)
            ? 'Explaining the Wilson bound (i.e. why things are ordered like this): http://alecbenzer.com/blog/how-to-sort-ratings/'
            : null;

        if (view === 'bestmessages' || view === 'worstmessages') {
            const rows = await votesByMessageInBackground(DB_PATH, view === 'worstmessages', interaction.guildId,
                vote, f.channelId, f.media, f.since, TOP_N);
            const channelName = (id) => interaction.guild?.channels.cache.get(id)?.name ?? 'message';
            heading = view === 'bestmessages' ? 'Best messages by net score' : 'Worst messages by net score';
            lines = rows.map((r, i) => `**${i + 1}.** ${sign(r.net)} (${n(r.up)} up, ${n(r.down)} down) · <@${r.author_id}> · `
                + `[#${channelName(r.channel_id)}](https://discord.com/channels/${interaction.guildId}/${r.channel_id}/${r.id}) · `
                + `<t:${Math.floor(createdAt(r.id) / 1000)}:d>`);
        } else if (view === 'net' || view === 'approval') {
            const rows = await votesByAuthorInBackground(DB_PATH, interaction.guildId, vote, f.channelId, f.media, f.since);
            if (view === 'net') {
                heading = 'Net score received';
                lines = rows.map(r => ({ ...r, net: r.up - r.down })).filter(r => r.net !== 0)
                    .sort((a, b) => b.net - a.net).slice(0, TOP_N)
                    .map((r, i) => `**${i + 1}.** <@${r.author_id}> — ${sign(r.net)} (${n(r.up)} up, ${n(r.down)} down)`);
            } else {
                heading = 'Approval';
                lines = rows.filter(r => r.up + r.down >= MIN_VOTES)
                    .sort((a, b) => wilson(b.up, b.up + b.down)[0] - wilson(a.up, a.up + a.down)[0]).slice(0, TOP_N)
                    .map((r, i) => `**${i + 1}.** <@${r.author_id}> — ${per1000(r.down, r.up + r.down)} down per 1,000 votes `
                        + `(${n(r.up)} up, ${n(r.down)} down)`);
                footer = `At least ${MIN_VOTES} votes to be ranked`;
            }
        } else {
            const rows = (await votingHabits(interaction.guildId, f, vote))
                .map(r => ({ ...r, votes: r.up_given + r.down_given }))
                .filter(r => r.votes >= MIN_VOTES);
            const harshest = view === 'harshest';
            heading = harshest ? 'Harshest voters' : 'Kindest voters';
            // Ranked by how sure we are of the rate: the low end for harsh, the high end for kind
            const rank = (r) => harshest ? -wilson(r.down_given, r.votes)[0] : wilson(r.down_given, r.votes)[1];
            lines = rows.sort((a, b) => rank(a) - rank(b)).slice(0, TOP_N)
                .map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${per1000(r.down_given, r.votes)} down per 1,000 votes `
                    + `(${n(r.up_given)} up, ${n(r.down_given)} down given)`);
            footer = `At least ${MIN_VOTES} votes to be ranked`;
        }

        const footerText = [footer, isScanning(interaction.guildId, keys) && 'Still counting older messages, totals may change.']
            .filter(Boolean).join(' · ');
        const embed = new EmbedBuilder()
            .setTitle(title({ display: '🗳️' }, heading, f.labels))
            .setDescription((lines.length ? lines.join('\n') : 'Nothing to rank yet.') + (explainer ? `\n\n${explainer}` : ''));
        if (footerText) embed.setFooter({ text: footerText });
        await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
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

            if (interaction.commandName === 'profile') {
                await replyProfile(interaction);
                return;
            }
            // These have no emoji option, so they are handled before the emoji lookup below
            const voteCommand = { votegraph: replyVoteGraph, emojigraph: replyEmojiGraph, votes: replyVotes }[interaction.commandName];
            if (voteCommand) {
                await voteCommand(interaction);
                return;
            }

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
            if (interaction.deferred) await interaction.editReply('Something went wrong, try again in a moment.').catch(() => {});
        }
    });
};

// The Server Members intent is only requested when repost bots are configured, since it's a privileged
// intent that has to be switched on in the Discord Developer Portal first
module.exports.extraIntents = () => configuredRepostBots().length ? [GatewayIntentBits.GuildMembers] : [];
