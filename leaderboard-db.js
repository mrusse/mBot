const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');

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
    -- counted: once reactors are known, how many of them count toward received (not bots or the author),
    --          stored so the leaderboard doesn't have to recount every message
    CREATE TABLE IF NOT EXISTS reactions (
        message_id       TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        emoji            TEXT NOT NULL,
        emoji_name       TEXT NOT NULL,
        match_key        TEXT NOT NULL,
        count            INTEGER NOT NULL,
        me               INTEGER NOT NULL,
        reactors_fetched INTEGER NOT NULL DEFAULT 0,
        counted          INTEGER NOT NULL DEFAULT 0,
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

    -- /profile looks up one person's messages and the reactions they gave
    CREATE INDEX IF NOT EXISTS messages_author ON messages (guild_id, author_id);
    CREATE INDEX IF NOT EXISTS reactors_user ON reactors (user_id);

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

    -- Small key/value store, e.g. which repost bot setup the message history was last scanned with
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
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

// Discord IDs start with their creation time (ms since 2015), so a message's posting time comes from its ID
const DISCORD_EPOCH = 1420070400000;

// Optional leaderboard filters: pass null to skip one
const FILTERS = `
    AND (? IS NULL OR m.channel_id = ?)
    AND (? IS NULL OR m.has_media = ?)
    AND (? IS NULL OR (CAST(m.id AS INTEGER) >> 22) + ${DISCORD_EPOCH} >= ?)
`;

// How many of a reaction count toward received: exact once who reacted is known (bots and the author
// left out), until then the message's reaction count minus this bot's own
const RECEIVED = `CASE WHEN r.reactors_fetched = 1 THEN r.counted ELSE r.count - r.me END`;

// How much one message counts toward received, for queries grouped by message. People sometimes react
// with several uploads of the same emoji (five different upvotes), so each person counts once: with
// one version that's just its count; with several, the distinct people across them once all are looked
// up, otherwise the highest single count. Only multi-version messages pay for the distinct count.
const MESSAGE_RECEIVED = `
    CASE WHEN COUNT(*) > 1 AND MIN(r.reactors_fetched) = 1 THEN (
        SELECT COUNT(DISTINCT x.user_id) FROM reactors x
        JOIN reactions r2 ON r2.message_id = x.message_id AND r2.emoji = x.emoji
        LEFT JOIN users u ON u.id = x.user_id
        WHERE x.message_id = m.id AND r2.match_key = r.match_key
          AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0)
    ELSE MAX(${RECEIVED}) END
`;

// Reactors who count toward received for one reaction: everyone except bots and the message author
const COUNTED = `
    SELECT COUNT(*) FROM reactors x
    JOIN messages m ON m.id = x.message_id
    LEFT JOIN users u ON u.id = x.user_id
    WHERE x.message_id = reactions.message_id AND x.emoji = reactions.emoji
      AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0
`;

function openDatabase(file) {
    const db = new DatabaseSync(file);
    db.exec(SCHEMA);

    // Databases created before the counted column existed: add it and fill it in once
    const columns = db.prepare('PRAGMA table_info(reactions)').all().map(c => c.name);
    if (!columns.includes('counted')) {
        db.exec(`
            BEGIN;
            ALTER TABLE reactions ADD COLUMN counted INTEGER NOT NULL DEFAULT 0;
            UPDATE reactions SET counted = (${COUNTED}) WHERE reactors_fetched = 1;
            COMMIT;
        `);
    }

    const q = Object.fromEntries(Object.entries({
        upsertMessage: `
            INSERT INTO messages (id, guild_id, channel_id, author_id, has_media) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET author_id = excluded.author_id, has_media = excluded.has_media`,
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
        refreshCounted: `UPDATE reactions SET counted = (${COUNTED}) WHERE message_id = ? AND emoji = ?`,
        refreshCountedForMessage: `UPDATE reactions SET counted = (${COUNTED}) WHERE message_id = ? AND reactors_fetched = 1`,
        authorOf: `SELECT author_id FROM messages WHERE id = ?`,

        upsertUser: `INSERT INTO users (id, bot) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET bot = excluded.bot`,

        channelScan: `SELECT before, done FROM channel_scans WHERE channel_id = ?`,
        saveChannelScan: `
            INSERT INTO channel_scans (channel_id, guild_id, before, done) VALUES (?, ?, ?, ?)
            ON CONFLICT (channel_id) DO UPDATE SET before = excluded.before, done = excluded.done`,
        restartChannelScans: `UPDATE channel_scans SET before = NULL, done = 0`,
        getSetting: `SELECT value FROM settings WHERE key = ?`,
        setSetting: `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,

        pendingChannels: `
            SELECT m.channel_id, COUNT(*) AS n
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.reactors_fetched = 0
              AND r.match_key IN (SELECT value FROM json_each(?))
            GROUP BY m.channel_id`,
        // Keys are in priority order (json_each's key is the array index), so the first emoji's
        // lookups are all done before the next one's
        pendingInChannel: `
            SELECT r.message_id, r.emoji, r.emoji_name
            FROM json_each(?) k
            JOIN reactions r ON r.match_key = k.value AND r.reactors_fetched = 0
            JOIN messages m ON m.id = r.message_id
            WHERE m.channel_id = ?
            ORDER BY k.key
            LIMIT ?`,
        pendingForMessage: `
            SELECT message_id, emoji, emoji_name, match_key FROM reactions
            WHERE message_id = ? AND reactors_fetched = 0`,
        hasPending: `
            SELECT 1 FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.match_key = ? AND r.reactors_fetched = 0
            LIMIT 1`,
        hasPendingAny: `
            SELECT 1 FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.reactors_fetched = 0 AND r.match_key IN (SELECT value FROM json_each(?))
            LIMIT 1`,
        // Same question without the guild, answered from the reactions_match index alone
        hasPendingEverywhere: `
            SELECT 1 FROM reactions
            WHERE reactors_fetched = 0 AND match_key IN (SELECT value FROM json_each(?))
            LIMIT 1`,

        received: `
            SELECT author_id AS user_id, SUM(per_message) AS total
            FROM (
                SELECT m.author_id, ${MESSAGE_RECEIVED} AS per_message
                FROM reactions r JOIN messages m ON m.id = r.message_id
                WHERE m.guild_id = ? AND r.match_key = ? ${FILTERS}
                GROUP BY m.id
            )
            GROUP BY author_id
            HAVING total > 0
            ORDER BY total DESC`,
        // Each person counts at most once per message, however many versions of the emoji they used
        given: `
            SELECT x.user_id, COUNT(DISTINCT x.message_id) AS total
            FROM reactors x
            JOIN reactions r ON r.message_id = x.message_id AND r.emoji = x.emoji
            JOIN messages m ON m.id = x.message_id
            LEFT JOIN users u ON u.id = x.user_id
            WHERE m.guild_id = ? AND r.match_key = ? AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0
              ${FILTERS}
            GROUP BY x.user_id
            ORDER BY total DESC`,
        topMessages: `
            SELECT m.id, m.channel_id, m.author_id, ${MESSAGE_RECEIVED} AS total
            FROM reactions r JOIN messages m ON m.id = r.message_id
            WHERE m.guild_id = ? AND r.match_key = ? AND (? IS NULL OR m.author_id = ?) ${FILTERS}
            GROUP BY m.id
            HAVING total > 0
            ORDER BY total DESC, m.id
            LIMIT ?`
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
    // authorId is who gets credit: normally the author, but the original poster for a repost bot's message.
    // Call inside a transaction.
    function storeMessage(message, authorId = message.author.id) {
        if (!message.reactions.cache.size) {
            q.deleteMessage.run(message.id);
            return;
        }
        const previousAuthor = q.authorOf.get(message.id)?.author_id;
        q.upsertMessage.run(message.id, message.guildId, message.channelId, authorId, hasMedia(message) ? 1 : 0);
        // A repost credited to someone else now (e.g. after fixing a repost bot format): self-reactions are
        // judged against the author, so recount the reactions already looked up
        if (previousAuthor && previousAuthor !== authorId) q.refreshCountedForMessage.run(message.id);

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
                    q.refreshCounted.run(messageId, id);
                    return;
                }
                let count = row.count + 1;
                if (row.reactors_fetched === 1) {
                    q.insertReactor.run(messageId, id, userId);
                    count = q.countReactors.get(messageId, id).n;
                }
                q.updateReaction.run(count, row.me || (isMe ? 1 : 0), messageId, id);
                if (row.reactors_fetched === 1) q.refreshCounted.run(messageId, id);
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
                    if (row.reactors_fetched === 1) q.refreshCounted.run(messageId, id);
                } else {
                    q.deleteReaction.run(messageId, id);
                    deleteMessageIfEmpty(messageId);
                }
            });
        },

        // After storing a message from a live reaction: if this is the only reaction with that emoji,
        // the reactor is already known and no lookup is needed
        markSoleReactor(messageId, emoji, userId) {
            const id = emojiId(emoji);
            const row = q.getReaction.get(messageId, id);
            if (!row || row.reactors_fetched !== 0) return false;
            if (row.count !== 1) return true;
            q.insertReactor.run(messageId, id, userId);
            q.setFetched.run(1, 1, messageId, id);
            q.refreshCounted.run(messageId, id);
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
                q.refreshCounted.run(messageId, emoji);
            });
        },

        markLookupFailed: (messageId, emoji) => q.markFailed.run(messageId, emoji),
        pendingForMessage: (messageId) => q.pendingForMessage.all(messageId),

        channelScan: (channelId) => q.channelScan.get(channelId) ?? { before: null, done: 0 },
        saveChannelScan: (channelId, guildId, before, done) =>
            q.saveChannelScan.run(channelId, guildId, before ?? null, done ? 1 : 0),
        // Makes every channel's message scan start again from the newest message; stored data is kept
        restartChannelScans: () => q.restartChannelScans.run(),
        getSetting: (key) => q.getSetting.get(key)?.value ?? null,
        setSetting: (key, value) => q.setSetting.run(key, value),

        pendingChannels: (guildId, keys) => q.pendingChannels.all(guildId, JSON.stringify(keys)),
        pendingInChannel: (channelId, keys, limit) => q.pendingInChannel.all(JSON.stringify(keys), channelId, limit),
        hasPending: (guildId, key) => !!q.hasPending.get(guildId, key),

        // media: 1 = media only, 0 = text only, null = all; since: only messages posted after this time (ms), or null
        leaderboard(type, guildId, key, channelId, media, since) {
            return q[type].all(guildId, key, channelId, channelId, media, media, since, since);
        },

        // The messages with the most of an emoji; authorId limits it to one person's messages, or null
        topMessages(guildId, key, authorId, channelId, media, since, limit) {
            return q.topMessages.all(guildId, key, authorId, authorId, channelId, channelId, media, media, since, since, limit);
        },

        // When nothing is pending anywhere the guild-aware query has to join every reaction of these
        // emojis to its message before it can say no (about half a second on this much data, on the
        // main thread), so the index-only check goes first
        hasPendingAny(guildId, keys) {
            const json = JSON.stringify(keys);
            return !!q.hasPendingEverywhere.get(json) && !!q.hasPendingAny.get(guildId, json);
        }
    };
}

// When a message (or anything else with a Discord ID) was created, in ms
const createdAt = (id) => Number(BigInt(id) >> 22n) + DISCORD_EPOCH;

// Total reactions per emoji in a server, for sorting suggestions by how often they're used
const USAGE = `
    SELECT r.match_key, SUM(r.count) AS total
    FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.guild_id = ?
    GROUP BY r.match_key
`;

// One person's messages, with how much each tracked emoji on them counts toward received
const PROFILE_RECEIVED = `
    SELECT m.id, m.channel_id, r.match_key, ${MESSAGE_RECEIVED} AS total
    FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.guild_id = ? AND m.author_id = ? AND r.match_key IN (SELECT value FROM json_each(?)) ${FILTERS}
    GROUP BY m.id, r.match_key
    HAVING total > 0
`;

// How many of each tracked emoji one person gave (at most once per message)
const PROFILE_GIVEN = `
    SELECT r.match_key, COUNT(DISTINCT x.message_id) AS total
    FROM reactors x
    JOIN reactions r ON r.message_id = x.message_id AND r.emoji = x.emoji
    JOIN messages m ON m.id = x.message_id
    WHERE x.user_id = ? AND m.guild_id = ? AND x.user_id != m.author_id
      AND r.match_key IN (SELECT value FROM json_each(?)) ${FILTERS}
    GROUP BY r.match_key
    ORDER BY total DESC
`;

// ---- vote analysis: charts, net score, approval, fans and haters -------------------------------------

// The month a message was posted in, as YYYY-MM, from its ID (see DISCORD_EPOCH)
const POSTED_MONTH = `strftime('%Y-%m', ((CAST(m.id AS INTEGER) >> 22) + ${DISCORD_EPOCH}) / 1000, 'unixepoch')`;

// One row per message per vote emoji, matched by exact emoji ID: the vote emojis are one specific upload
// each, since other servers have their own emojis with the same names and matching by name would count
// those too. A message can only hold one row per emoji, so there is nothing to merge.
// Params: upId, guildId, upId, downId, authorId (twice, null for everyone), then the filters
const VOTES_PER_MESSAGE = `
    SELECT m.id, m.channel_id, m.author_id, ${POSTED_MONTH} AS month,
           r.emoji = ? AS is_up, ${RECEIVED} AS total
    FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.guild_id = ? AND r.emoji IN (?, ?) AND (? IS NULL OR m.author_id = ?) ${FILTERS}
`;

const UP_SUM = `SUM(CASE WHEN is_up THEN total ELSE 0 END)`;
const DOWN_SUM = `SUM(CASE WHEN is_up THEN 0 ELSE total END)`;

const VOTES_BY_MONTH = `
    SELECT month, ${UP_SUM} AS up, ${DOWN_SUM} AS down
    FROM (${VOTES_PER_MESSAGE}) GROUP BY month ORDER BY month
`;

const VOTES_BY_AUTHOR = `
    SELECT author_id, ${UP_SUM} AS up, ${DOWN_SUM} AS down
    FROM (${VOTES_PER_MESSAGE}) GROUP BY author_id
`;

// Messages with the best or worst net score. ORDER BY can't be a bound parameter, so there are two
const votesByMessage = (having, order) => `
    SELECT id, channel_id, author_id, ${UP_SUM} AS up, ${DOWN_SUM} AS down,
           SUM(CASE WHEN is_up THEN total ELSE -total END) AS net
    FROM (${VOTES_PER_MESSAGE}) GROUP BY id HAVING ${having} ORDER BY net ${order}, id LIMIT ?
`;
const BEST_MESSAGES = votesByMessage('net > 0', 'DESC');
const WORST_MESSAGES = votesByMessage('net < 0', 'ASC');

// Who votes on one person's messages, and how often. CROSS JOIN pins the join order so SQLite starts
// from that person's messages (messages_author); left to itself it starts from every vote in the
// server and takes about ten times as long.
// Params: upId, upId, downId, guildId, authorId, then the filters
const FANS = `
    SELECT x.user_id, r.emoji = ? AS is_up, COUNT(DISTINCT x.message_id) AS total
    FROM messages m
    CROSS JOIN reactions r ON r.message_id = m.id AND r.emoji IN (?, ?)
    CROSS JOIN reactors x ON x.message_id = r.message_id AND x.emoji = r.emoji
    LEFT JOIN users u ON u.id = x.user_id
    WHERE m.guild_id = ? AND m.author_id = ? AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0
      ${FILTERS}
    GROUP BY x.user_id, is_up
`;

// How many of each vote everyone has given, at most once per message. Adds up every vote in the
// server, so callers cache it.
// Params: upId, downId, guildId, upId, downId, then the filters
const HABITS = `
    SELECT x.user_id,
           COUNT(DISTINCT CASE WHEN r.emoji = ? THEN x.message_id END) AS up_given,
           COUNT(DISTINCT CASE WHEN r.emoji = ? THEN x.message_id END) AS down_given
    FROM reactors x
    JOIN reactions r ON r.message_id = x.message_id AND r.emoji = x.emoji
    JOIN messages m ON m.id = x.message_id
    LEFT JOIN users u ON u.id = x.user_id
    WHERE m.guild_id = ? AND r.emoji IN (?, ?) AND x.user_id != m.author_id AND COALESCE(u.bot, 0) = 0
      ${FILTERS}
    GROUP BY x.user_id
`;

// The vote emojis only count as the exact upload (same as the vote commands), so the chart's upvote line
// agrees with them. Params: the two vote keys, then the two vote IDs
const ONLY_EXACT_VOTES = `AND NOT (r.match_key IN (?, ?) AND r.emoji NOT IN (?, ?))`;

// Emoji per month by the reactions a message's author received (authorId null for everyone)
const EMOJI_RECEIVED_BY_MONTH = `
    SELECT month, match_key, SUM(total) AS total
    FROM (
        SELECT ${POSTED_MONTH} AS month, r.match_key, ${MESSAGE_RECEIVED} AS total
        FROM reactions r JOIN messages m ON m.id = r.message_id
        WHERE m.guild_id = ? AND r.match_key IN (SELECT value FROM json_each(?))
          ${ONLY_EXACT_VOTES} AND (? IS NULL OR m.author_id = ?) ${FILTERS}
        GROUP BY m.id, r.match_key
    )
    GROUP BY month, match_key
`;

// Emoji per month by the reactions one person gave (same counting as PROFILE_GIVEN)
const EMOJI_GIVEN_BY_MONTH = `
    SELECT ${POSTED_MONTH} AS month, r.match_key, COUNT(DISTINCT x.message_id) AS total
    FROM reactors x
    JOIN reactions r ON r.message_id = x.message_id AND r.emoji = x.emoji
    JOIN messages m ON m.id = x.message_id
    WHERE x.user_id = ? AND m.guild_id = ? AND x.user_id != m.author_id
      AND r.match_key IN (SELECT value FROM json_each(?)) ${ONLY_EXACT_VOTES} ${FILTERS}
    GROUP BY month, r.match_key
`;

const filterParams = (channelId, media, since) => [channelId, channelId, media, media, since, since];
const votesParams = (vote, guildId, authorId, filters) =>
    [vote.up.id, guildId, vote.up.id, vote.down.id, authorId, authorId, ...filters];

// Vote emojis as { up: { key, id }, down: { key, id } }, or null when none are set up. Blanks match
// nothing, which turns ONLY_EXACT_VOTES off
const exactVoteParams = (vote) => vote ? [vote.up.key, vote.down.key, vote.up.id, vote.down.id] : ['', '', '', ''];

// Runs read-only queries in a worker thread with its own connection, so slow ones (adding up every
// reaction, a heavy /profile) don't stall the bot. SQLite lets it read while the bot keeps writing.
const QUERY_WORKER = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.file, { readOnly: true });
    parentPort.postMessage(workerData.queries.map(({ sql, params }) =>
        db.prepare(sql).all(...params).map(row => ({ ...row }))));
    db.close();
`;

// Resolves to each query's rows, in order
function queryInBackground(file, queries) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(QUERY_WORKER, {
            eval: true,
            workerData: { file, queries },
            // node:sqlite prints an experimental warning each time a thread loads it
            execArgv: ['--no-warnings']
        });
        worker.once('message', resolve);
        worker.once('error', reject);
    });
}

// Resolves to a Map of guild ID -> Map of emoji key -> total reactions
async function usageInBackground(file, guildIds) {
    const results = await queryInBackground(file, guildIds.map(id => ({ sql: USAGE, params: [id] })));
    return new Map(guildIds.map((id, i) => [id, new Map(results[i].map(r => [r.match_key, r.total]))]));
}

// Everything /profile shows for one person, over the given emoji keys and filters. With vote (see
// votesParams) it also returns who votes on their messages, in the same worker
async function profileInBackground(file, guildId, userId, keys, channelId, media, since, vote = null) {
    const filters = filterParams(channelId, media, since);
    const queries = [
        { sql: PROFILE_RECEIVED, params: [guildId, userId, JSON.stringify(keys), ...filters] },
        { sql: PROFILE_GIVEN, params: [userId, guildId, JSON.stringify(keys), ...filters] }
    ];
    if (vote) {
        queries.push({ sql: FANS, params: [vote.up.id, vote.up.id, vote.down.id, guildId, userId, ...filters] });
    }
    const [received, given, fans = []] = await queryInBackground(file, queries);
    return { received, given, fans };
}

// Votes received per month; authorId limits it to one person's messages, or null
const votesByMonthInBackground = async (file, guildId, vote, authorId, channelId, media, since) =>
    (await queryInBackground(file, [{
        sql: VOTES_BY_MONTH,
        params: votesParams(vote, guildId, authorId, filterParams(channelId, media, since))
    }]))[0];

// Votes received per author
const votesByAuthorInBackground = async (file, guildId, vote, channelId, media, since) =>
    (await queryInBackground(file, [{
        sql: VOTES_BY_AUTHOR,
        params: votesParams(vote, guildId, null, filterParams(channelId, media, since))
    }]))[0];

// The messages with the best (worst = false) or worst net score
const votesByMessageInBackground = async (file, worst, guildId, vote, channelId, media, since, limit) =>
    (await queryInBackground(file, [{
        sql: worst ? WORST_MESSAGES : BEST_MESSAGES,
        params: [...votesParams(vote, guildId, null, filterParams(channelId, media, since)), limit]
    }]))[0];

// How many of each vote everyone has given
const votingHabitsInBackground = async (file, guildId, vote, channelId, media, since) =>
    (await queryInBackground(file, [{
        sql: HABITS,
        params: [vote.up.id, vote.down.id, guildId, vote.up.id, vote.down.id, ...filterParams(channelId, media, since)]
    }]))[0];

// Emoji use per month. given = what personId reacted with; otherwise what personId's messages received
// (null for everyone's). vote is optional, see ONLY_EXACT_VOTES
async function emojiByMonthInBackground(file, guildId, keys, given, personId, channelId, media, since, vote = null) {
    const filters = filterParams(channelId, media, since);
    const exact = exactVoteParams(vote);
    const query = given
        ? { sql: EMOJI_GIVEN_BY_MONTH, params: [personId, guildId, JSON.stringify(keys), ...exact, ...filters] }
        : { sql: EMOJI_RECEIVED_BY_MONTH, params: [guildId, JSON.stringify(keys), ...exact, personId, personId, ...filters] };
    return (await queryInBackground(file, [query]))[0];
}

module.exports = {
    openDatabase, emojiKey, hasMedia, createdAt, usageInBackground, profileInBackground,
    votesByMonthInBackground, votesByAuthorInBackground, votesByMessageInBackground,
    votingHabitsInBackground, emojiByMonthInBackground
};
