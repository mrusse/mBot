const { DatabaseSync } = require('node:sqlite');

// Only IDs, counts and flags are stored, never message content or usernames.
// Only messages that have reactions (and aren't from bots) are stored.
const SCHEMA = `
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id  TEXT NOT NULL,
        has_media  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_guild_channel ON messages (guild_id, channel_id);

    -- Every emoji on every stored message, tracked or not, so adding an emoji to the config needs no rescan.
    -- reactors_fetched: 0 = who reacted not looked up yet, 1 = reactors table is complete, -1 = lookup failed
    CREATE TABLE IF NOT EXISTS reactions (
        message_id       TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        emoji            TEXT NOT NULL,
        emoji_name       TEXT NOT NULL,
        match_key        TEXT NOT NULL,
        count            INTEGER NOT NULL,
        me               INTEGER NOT NULL,
        reactors_fetched INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS reactions_match ON reactions (match_key, reactors_fetched);

    CREATE TABLE IF NOT EXISTS reactors (
        message_id TEXT NOT NULL,
        emoji      TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        PRIMARY KEY (message_id, emoji, user_id),
        FOREIGN KEY (message_id, emoji) REFERENCES reactions (message_id, emoji) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
        id  TEXT PRIMARY KEY,
        bot INTEGER NOT NULL
    );

    -- How far the message scan has got in each channel, so a restart resumes it
    CREATE TABLE IF NOT EXISTS channel_scans (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        before     TEXT,
        done       INTEGER NOT NULL DEFAULT 0
    );
`;

// What the config matches on: custom emojis by lowercase name, so every upload of an emoji with the
// same name counts together; standard emojis by the character
const emojiKey = (emoji) => emoji.id ? (emoji.name ?? '').toLowerCase() : emoji.name;

// Identifies one specific emoji: the ID for custom emojis, the character for standard ones
const emojiId = (emoji) => emoji.id ?? emoji.name;

// Uploads, images, link previews (embeds) and stickers all count as media
const hasMedia = (message) =>
    message.attachments.size > 0 || message.embeds.length > 0 || message.stickers.size > 0;

// Optional leaderboard filters: pass null to skip one
const FILTERS = `
    AND (? IS NULL OR m.channel_id = ?)
    AND (? IS NULL OR m.has_media = ?)
`;

function openDatabase(file) {
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);

    const q = Object.fromEntries(Object.entries({
        upsertMessage: `
            INSERT INTO messages (id, guild_id, channel_id, author_id, has_media) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET has_media = excluded.has_media`,
        deleteMessage: `DELETE FROM messages WHERE id = ?`,
        hasMessage: `SELECT 1 FROM messages WHERE id = ?`,
        setMedia: `UPDATE messages SET has_media = 1 WHERE id = ?`,

        reactionsOf: `SELECT emoji, count FROM reactions WHERE message_id = ?`,
        countReactionsOf: `SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?`,
        getReaction: `SELECT count, me, reactors_fetched FROM reactions WHERE message_id = ? AND emoji = ?`,
        upsertReaction: `
            INSERT INTO reactions (message_id, emoji, emoji_name, match_key, count, me, reactors_fetched)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (message_id, emoji) DO UPDATE SET
                count = excluded.count, me = excluded.me, reactors_fetched = excluded.reactors_fetched`,
        updateReaction: `UPDATE reactions SET count = ?, me = ? WHERE message_id = ? AND emoji = ?`,
        setFetched: `UPDATE reactions SET reactors_fetched = ?, count = ? WHERE message_id = ? AND emoji = ?`,
        markFailed: `UPDATE reactions SET reactors_fetched = -1 WHERE message_id = ? AND emoji = ?`,
        resetFailed: `UPDATE reactions SET reactors_fetched = 0 WHERE reactors_fetched = -1`,
        deleteReaction: `DELETE FROM reactions WHERE message_id = ? AND emoji = ?`,

        insertReactor: `INSERT OR IGNORE INTO reactors (message_id, emoji, user_id) VALUES (?, ?, ?)`,
        deleteReactor: `DELETE FROM reactors WHERE message_id = ? AND emoji = ? AND user_id = ?`,
        clearReactors: `DELETE FROM reactors WHERE message_id = ? AND emoji = ?`,
        countReactors: `SELECT COUNT(*) AS n FROM reactors WHERE message_id = ? AND emoji = ?`,

        upsertUser: `INSERT INTO users (id, bot) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET bot = excluded.bot`,

        channelScan: `SELECT before, done FROM channel_scans WHERE channel_id = ?`,
        saveChannelScan: `
            INSERT INTO channel_scans (channel_id, guild_id, before, done) VALUES (?, ?, ?, ?)
            ON CONFLICT (channel_id) DO UPDATE SET before = excluded.before, done = excluded.done`,

        pendingChannels: `
            SELECT m.channel_id, COUNT(*) AS n
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.reactors_fetched = 0
              AND r.match_key IN (SELECT value FROM json_each(?))
            GROUP BY m.channel_id`,
        pendingInChannel: `
            SELECT r.message_id, r.emoji, r.emoji_name
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.channel_id = ? AND r.reactors_fetched = 0
              AND r.match_key IN (SELECT value FROM json_each(?))
            LIMIT ?`,
        hasPending: `
            SELECT 1 FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.match_key = ? AND r.reactors_fetched = 0
            LIMIT 1`,

        // Once who reacted is known, bots and self-reactions are left out exactly;
        // until then the message's reaction count (minus this bot's own) is used
        received: `
            SELECT m.author_id AS user_id, SUM(CASE WHEN r.reactors_fetched = 1 THEN (
                       SELECT COUNT(*) FROM reactors x LEFT JOIN users u ON u.id = x.user_id
                       WHERE x.message_id = r.message_id AND x.emoji = r.emoji
                         AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0)
                   ELSE r.count - r.me END) AS total
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.match_key = ? ${FILTERS}
            GROUP BY m.author_id
            HAVING total > 0
            ORDER BY total DESC`,
        given: `
            SELECT x.user_id, COUNT(*) AS total
            FROM reactors x
            JOIN reactions r ON r.message_id = x.message_id AND r.emoji = x.emoji
            JOIN messages m ON m.id = x.message_id
            LEFT JOIN users u ON u.id = x.user_id
            WHERE m.guild_id = ? AND r.match_key = ? AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0
              ${FILTERS}
            GROUP BY x.user_id
            ORDER BY total DESC`
    }).map(([name, sql]) => [name, db.prepare(sql)]));

    function transaction(fn) {
        db.exec('BEGIN');
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    }

    function deleteMessageIfEmpty(messageId) {
        if (q.countReactionsOf.get(messageId).n === 0) q.deleteMessage.run(messageId);
    }

    // Stores a message and the counts of every emoji on it. Reaction lists that are still accurate
    // (same count as before) are kept; changed ones are marked for another who-reacted lookup.
    // Call inside a transaction.
    function storeMessage(message) {
        if (!message.reactions.cache.size) {
            q.deleteMessage.run(message.id);
            return;
        }
        q.upsertMessage.run(message.id, message.guildId, message.channelId, message.author.id, hasMedia(message) ? 1 : 0);

        const stale = new Map(q.reactionsOf.all(message.id).map(r => [r.emoji, r.count]));
        for (const reaction of message.reactions.cache.values()) {
            const id = emojiId(reaction.emoji);
            const unchanged = stale.get(id) === reaction.count;
            stale.delete(id);
            if (unchanged) continue;
            q.clearReactors.run(message.id, id);
            q.upsertReaction.run(message.id, id, reaction.emoji.name ?? '', emojiKey(reaction.emoji),
                reaction.count, reaction.me ? 1 : 0, 0);
        }
        for (const id of stale.keys()) q.deleteReaction.run(message.id, id);
    }

    return {
        transaction,
        storeMessage,
        hasMessage: (messageId) => !!q.hasMessage.get(messageId),
        deleteMessage: (messageId) => q.deleteMessage.run(messageId),
        setMedia: (messageId) => q.setMedia.run(messageId),
        upsertUser: (id, bot) => q.upsertUser.run(id, bot ? 1 : 0),
        resetFailedLookups: () => q.resetFailed.run(),

        // A live reaction on a message that is already stored
        addReactor(messageId, emoji, userId, isMe) {
            transaction(() => {
                const id = emojiId(emoji);
                const row = q.getReaction.get(messageId, id);
                if (!row) {
                    // First reaction with this emoji, so the full reactor list is known
                    q.upsertReaction.run(messageId, id, emoji.name ?? '', emojiKey(emoji), 1, isMe ? 1 : 0, 1);
                    q.insertReactor.run(messageId, id, userId);
                    return;
                }
                let count = row.count + 1;
                if (row.reactors_fetched === 1) {
                    q.insertReactor.run(messageId, id, userId);
                    count = q.countReactors.get(messageId, id).n;
                }
                q.updateReaction.run(count, row.me || (isMe ? 1 : 0), messageId, id);
            });
        },

        removeReactor(messageId, emoji, userId, isMe) {
            transaction(() => {
                const id = emojiId(emoji);
                const row = q.getReaction.get(messageId, id);
                if (!row) return;
                let count = row.count - 1;
                if (row.reactors_fetched === 1) {
                    q.deleteReactor.run(messageId, id, userId);
                    count = q.countReactors.get(messageId, id).n;
                }
                if (count > 0) {
                    q.updateReaction.run(count, isMe ? 0 : row.me, messageId, id);
                } else {
                    q.deleteReaction.run(messageId, id);
                    deleteMessageIfEmpty(messageId);
                }
            });
        },

        // After storing a message from a live reaction: if this is the only reaction with that emoji,
        // the reactor is already known and no lookup is needed. Returns true if a lookup is still needed.
        markSoleReactor(messageId, emoji, userId) {
            const id = emojiId(emoji);
            const row = q.getReaction.get(messageId, id);
            if (!row || row.reactors_fetched !== 0) return false;
            if (row.count !== 1) return true;
            q.insertReactor.run(messageId, id, userId);
            q.setFetched.run(1, 1, messageId, id);
            return false;
        },

        removeEmoji(messageId, emoji) {
            transaction(() => {
                q.deleteReaction.run(messageId, emojiId(emoji));
                deleteMessageIfEmpty(messageId);
            });
        },

        setReactors(messageId, emoji, users) {
            transaction(() => {
                q.clearReactors.run(messageId, emoji);
                for (const user of users) {
                    q.upsertUser.run(user.id, user.bot ? 1 : 0);
                    q.insertReactor.run(messageId, emoji, user.id);
                }
                q.setFetched.run(1, users.length, messageId, emoji);
            });
        },

        markLookupFailed: (messageId, emoji) => q.markFailed.run(messageId, emoji),

        channelScan: (channelId) => q.channelScan.get(channelId) ?? { before: null, done: 0 },
        saveChannelScan: (channelId, guildId, before, done) =>
            q.saveChannelScan.run(channelId, guildId, before ?? null, done ? 1 : 0),

        pendingChannels: (guildId, keys) => q.pendingChannels.all(guildId, JSON.stringify(keys)),
        pendingInChannel: (channelId, keys, limit) => q.pendingInChannel.all(channelId, JSON.stringify(keys), limit),
        hasPending: (guildId, key) => !!q.hasPending.get(guildId, key),

        // media: 1 = media only, 0 = text only, null = all
        leaderboard(type, guildId, key, channelId, media) {
            return q[type].all(guildId, key, channelId, channelId, media, media);
        }
    };
}

module.exports = { openDatabase, emojiKey, hasMedia };
