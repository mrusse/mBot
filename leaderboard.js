const fs = require('fs');
const path = require('path');
const {
    ChannelType,
    EmbedBuilder,
    Events,
    InteractionContextType,
    MessageFlags,
    PermissionFlagsBits,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const { openDatabase, emojiKey, hasMedia } = require('./leaderboard-db');

const CONFIG_PATH = path.join(__dirname, 'leaderboard-config.json');
const DB_PATH = path.join(__dirname, 'leaderboard.db');
const TOP_N = 10;
const SCAN_CONCURRENCY = 5;
const READ_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const SCANNED_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const commands = [
    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show who has received or given the most of a reaction')
        .setContexts(InteractionContextType.Guild)
        .addStringOption(opt => opt
            .setName('emoji')
            .setDescription('The reaction to rank by')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt => opt
            .setName('type')
            .setDescription('Rank by reactions received (default) or given')
            .addChoices({ name: 'Received', value: 'received' }, { name: 'Given', value: 'given' }))
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
];

// Custom emojis are keyed by lowercase name, so every upload of an emoji with the same name counts together; standard emojis by the character
function parseEmoji(text) {
    const trimmed = text.trim();
    const custom = trimmed.match(/^<?(?:(a):)?:?(\w+):(\d+)>?$/);
    if (custom) {
        const [, animated, name, id] = custom;
        return { key: name.toLowerCase(), name, display: `<${animated ? 'a' : ''}:${name}:${id}>` };
    }
    return { key: trimmed, name: trimmed, display: trimmed };
}

const formatDuration = (ms) => {
    const mins = Math.round(ms / 60_000);
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};

module.exports = function setupLeaderboard(client, log) {
    let config = { mtime: 0, tracked: [], lastError: null };

    // Re-read the config whenever the file changes, so edits apply without a restart
    function getTracked() {
        try {
            const { mtimeMs } = fs.statSync(CONFIG_PATH);
            if (mtimeMs !== config.mtime) {
                const { emojis = [] } = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
                config = { mtime: mtimeMs, tracked: emojis.map(parseEmoji), lastError: null };
                log.info(`Leaderboard tracking: ${config.tracked.map(e => e.name).join(', ') || '(none)'}`);
            }
        } catch (err) {
            if (err.message !== config.lastError) {
                log.error(`Could not read ${path.basename(CONFIG_PATH)}: ${err.message}`);
                config.lastError = err.message;
            }
        }
        return config.tracked;
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
            if (full.author.bot) return;

            const needsLookup = db.transaction(() => {
                db.storeMessage(full);
                return db.markSoleReactor(full.id, reaction.emoji, user.id);
            });
            if (needsLookup && getTracked().some(e => e.key === emojiKey(reaction.emoji))) scheduleScan();
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
                const batch = await channel.messages.fetch({ limit: 100, before: before ?? undefined });
                scanned += batch.size;
                const done = batch.size < 100;
                before = batch.lastKey() ?? before;
                // Stored together with the position, so a restart never skips or repeats a batch
                const saveStarted = Date.now();
                db.transaction(() => {
                    for (const message of batch.values()) {
                        if (!message.author.bot && message.reactions.cache.size) db.storeMessage(message);
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
                        db.setReactors(row.message_id, row.emoji, await fetchAllReactors(channelId, row));
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
    let scanTimer = null;
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
                const keys = getTracked().map(e => e.key);

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
                    }

                    if (keys.length) await lookupReactors(guild, keys);
                }
            } while (scanQueued);
        } catch (err) {
            log.error(`Scan failed: ${err.message}`);
        } finally {
            scanRunning = false;
        }
    }

    // Batches up lookups needed by live reactions instead of running one per reaction
    function scheduleScan() {
        scanTimer ??= setTimeout(() => {
            scanTimer = null;
            runScans();
        }, 60_000);
    }

    // New emojis in the config, new channels, or permission changes that may let the bot read more channels
    fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => runScans());
    client.on(Events.GuildCreate, () => runScans());
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
        runScans();
    });

    // ---- /leaderboard ----

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isAutocomplete() && interaction.commandName === 'leaderboard') {
                const typed = interaction.options.getFocused().replaceAll(':', '').toLowerCase();
                const choices = getTracked()
                    .filter(e => e.name.toLowerCase().includes(typed))
                    .slice(0, 25)
                    .map(e => ({ name: e.name, value: e.key }));
                await interaction.respond(choices);
                return;
            }

            if (!interaction.isChatInputCommand() || interaction.commandName !== 'leaderboard') return;

            const input = interaction.options.getString('emoji');
            const tracked = getTracked();
            const name = input.trim().replace(/^:|:$/g, '').toLowerCase();
            const emoji = tracked.find(e => e.key === parseEmoji(input).key)
                ?? tracked.find(e => e.name.toLowerCase() === name);

            if (!emoji) {
                const list = tracked.map(e => e.display).join(' ') || '(none configured)';
                await interaction.reply({
                    content: `That emoji isn't on the leaderboard. Tracked emojis: ${list}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const type = interaction.options.getString('type') ?? 'received';
            const channel = interaction.options.getChannel('channel');
            const content = interaction.options.getString('content') ?? 'all';
            const media = content === 'media' ? 1 : content === 'text' ? 0 : null;

            const ranked = db.leaderboard(type, interaction.guildId, emoji.key, channel?.id ?? null, media);
            const top = ranked.slice(0, TOP_N);

            const myIndex = ranked.findIndex(r => r.user_id === interaction.user.id);
            const verb = type === 'given' ? 'given' : 'received';
            const myRank = myIndex === -1
                ? `**Your rank:** none yet, you haven't ${verb} any ${emoji.display}`
                : `**Your rank:** #${myIndex + 1} of ${ranked.length} — ${ranked[myIndex].total}`;

            const filters = [
                type === 'given' ? 'Given' : 'Received',
                channel && `#${channel.name}`,
                content === 'media' && 'Media only',
                content === 'text' && 'Text only'
            ].filter(Boolean).join(' · ');

            const embed = new EmbedBuilder()
                .setTitle(`${emoji.display} Leaderboard · ${filters}`)
                .setDescription(top.length
                    ? top.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${r.total}`).join('\n') + '\n\n' + myRank
                    : 'No reactions counted yet.');

            if (scanningGuilds.has(interaction.guildId) || db.hasPending(interaction.guildId, emoji.key)) {
                embed.setFooter({ text: 'Still counting older messages, totals may change.' });
            }

            // Mentions in embeds don't notify anyway, but make sure the leaderboard can never ping
            await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
            log.error(`Leaderboard command failed: ${err.message}`);
        }
    });
};
