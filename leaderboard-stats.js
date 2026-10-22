// Pure maths for the vote commands. No database or Discord in here, so it can be tested on its own

const WILSON_Z = 1.96;           // 95% confidence
const MIN_BASELINE_SHARE = 0.001; // a baseline of zero would make any downvote look infinitely hateful
const MIN_BASELINE_VOTES = 20;   // votes elsewhere needed before a voter's usual rate means anything
const MIN_HATER_DOWNVOTES = 3;   // downvotes on someone before it can be called a pattern
const MIN_FAN_UPVOTES = 5;       // upvotes on someone before it can be called a pattern
const MIN_HATER_TOTAL_DOWNVOTES = 25; // downvotes someone gave in total before they are the headline hater
const MIN_FAN_TOTAL_UPVOTES = 10;     // upvotes someone gave in total before they are the headline fan
const TOP_MESSAGES = 3;          // how many of an emoji's biggest messages /emoji lists
const MIN_MAGNET_MESSAGES = 20;  // messages someone needs with a reaction before their hit rate means anything

const DEFAULT_SCORE = (r) => r.up - r.down;

// [low, high] bound on the true share behind k out of n. Small samples give wide bounds, so ranking by
// the low end keeps 5 upvotes and 0 downvotes from beating 5000 upvotes and 30 downvotes
function wilson(k, n) {
    if (n === 0) return [0, 1];
    const p = k / n;
    const z2 = WILSON_Z ** 2;
    const centre = p + z2 / (2 * n);
    const spread = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    const scale = 1 + z2 / n;
    return [Math.max(0, (centre - spread) / scale), Math.min(1, (centre + spread) / scale)];
}

// Every YYYY-MM from first to last, so months with no votes still get a point on the chart
function monthRange(first, last) {
    const months = [];
    let [year, month] = first.split('-').map(Number);
    const [lastYear, lastMonth] = last.split('-').map(Number);
    while (year < lastYear || (year === lastYear && month <= lastMonth)) {
        months.push(`${year}-${String(month).padStart(2, '0')}`);
        if (++month > 12) { month = 1; year++; }
    }
    return months;
}

// One number per month, zero where the rows have none. valueOf picks the number from a row
function alignToMonths(rows, months, valueOf) {
    const byMonth = new Map(rows.map(r => [r.month, valueOf(r)]));
    return months.map(m => byMonth.get(m) ?? 0);
}

function runningTotal(values) {
    let sum = 0;
    return values.map(v => sum += v);
}

// The months a set of row lists spans, or null when they are all empty
function spanOf(...rowLists) {
    const months = rowLists.flat().map(r => r.month).sort();
    return months.length ? monthRange(months[0], months[months.length - 1]) : null;
}

// A window edge from the commands: 2024 or 2024-03 as a YYYY-MM. A bare year means its first month for a
// start and its last for an end. Returns null when the text isn't a date
function parseMonth(text, isEnd) {
    const match = /^(\d{4})(?:-(\d{2}))?$/.exec(String(text).trim());
    if (!match) return null;
    const month = match[2] ?? (isEnd ? '12' : '01');
    return Number(month) >= 1 && Number(month) <= 12 ? `${match[1]}-${month}` : null;
}

// Rows limited to the months between from and to, either of which can be null. YYYY-MM sorts as text
const trimMonths = (rows, from, to) =>
    rows.filter(r => (from === null || r.month >= from) && (to === null || r.month <= to));

// One number divided by another per month, or per running total when cumulative. A month with nothing to
// divide by is null, which the chart draws as a gap rather than as zero
function ratioSeries(numerators, denominators, cumulative) {
    const top = cumulative ? runningTotal(numerators) : numerators;
    const bottom = cumulative ? runningTotal(denominators) : denominators;
    return top.map((n, i) => bottom[i] === 0 ? null : n / bottom[i]);
}

// Votes on one person by voter, as a Map of user ID -> { up, down }
function tally(onYou) {
    const votes = new Map();
    for (const r of onYou) {
        const entry = votes.get(r.user_id) ?? { up: 0, down: 0 };
        entry[r.is_up ? 'up' : 'down'] += r.total;
        votes.set(r.user_id, entry);
    }
    return votes;
}

// The month n months before (or after, if negative) a YYYY-MM
function shiftMonth(month, n) {
    const [year, mon] = month.split('-').map(Number);
    const index = year * 12 + (mon - 1) - n;
    return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}

// Score over the last 12 months up to and including currentMonth, and over the 12 before that. Rows are
// { month, up, down } for one channel, or anything else with a month when scoreOf says what to add up
function trendOf(rows, currentMonth, scoreOf = DEFAULT_SCORE) {
    const recentFrom = shiftMonth(currentMonth, 11);
    const priorFrom = shiftMonth(currentMonth, 23);
    let recent = 0;
    let prior = 0;
    for (const r of rows) {
        if (r.month >= recentFrom && r.month <= currentMonth) recent += scoreOf(r);
        else if (r.month >= priorFrom && r.month < recentFrom) prior += scoreOf(r);
    }
    return { recent, prior };
}

// The month with the best score, or null with no rows. Ties go to the earlier month
function peakMonth(rows, scoreOf = DEFAULT_SCORE) {
    let best = null;
    for (const r of rows) {
        if (!best || scoreOf(r) > best.score) best = { month: r.month, score: scoreOf(r) };
    }
    return best;
}

// Voters ranked by how much more they downvote one person than they do everyone else.
// onYou: rows of { user_id, is_up, total } for the person. habits: Map of user ID -> { up_given, down_given }
// over everything they voted on. Voters are compared with their own rate elsewhere, so someone who
// downvotes everybody a lot doesn't top the list for being harsh
function rankHaters(onYou, habits) {
    const votes = tally(onYou);
    const ranked = [];
    for (const [userId, { up, down }] of votes) {
        const habit = habits.get(userId);
        if (!habit || down < MIN_HATER_DOWNVOTES) continue;
        const onYouVotes = up + down;
        const elseVotes = habit.up_given + habit.down_given - onYouVotes;
        if (elseVotes < MIN_BASELINE_VOTES) continue;
        const elseDown = Math.max(0, habit.down_given - down);
        const baseline = Math.max(elseDown / elseVotes, MIN_BASELINE_SHARE);
        ranked.push({
            userId,
            down,
            totalDown: habit.down_given,
            votes: onYouVotes,
            lift: down / onYouVotes / baseline,
            score: wilson(down, onYouVotes)[0] / baseline
        });
    }
    return ranked.sort((a, b) => b.score - a.score);
}

// Voters ranked by how much of their upvoting goes to one person, against the share of everyone's upvoting
// that person gets. Upvotes are about 97% of all votes for nearly everyone, so comparing upvote share on
// the person against elsewhere (the way rankHaters does for downvotes) barely moves and ranks nothing.
// Same inputs as rankHaters
function rankFans(onYou, habits) {
    const votes = tally(onYou);
    let everyoneUp = 0;
    let personUp = 0;
    for (const habit of habits.values()) everyoneUp += habit.up_given;
    for (const { up } of votes.values()) personUp += up;
    if (everyoneUp === 0 || personUp === 0) return [];
    const baseline = personUp / everyoneUp;
    const ranked = [];
    for (const [userId, { up }] of votes) {
        const habit = habits.get(userId);
        if (!habit || habit.up_given === 0 || up < MIN_FAN_UPVOTES) continue;
        ranked.push({
            userId,
            up,
            totalUp: habit.up_given,
            share: up / habit.up_given,
            lift: up / habit.up_given / baseline,
            score: wilson(up, habit.up_given)[0] / baseline
        });
    }
    return ranked.sort((a, b) => b.score - a.score);
}

// The top of a ranking, and the first with at least minTotal votes overall to be a headline. They are the
// same person unless the top pick has only a few votes overall, which is worth saying next to the real one
function pickTop(ranked, totalOf, minTotal) {
    return { top: ranked[0] ?? null, qualified: ranked.find(r => totalOf(r) >= minTotal) ?? null };
}

// The n rows with the highest value, best first. A linear pass, since an emoji can sit on 100,000+ messages
// and sorting them all to read three is wasted work. Ties go to the earlier message
function topRows(rows, n, valueOf) {
    const better = (a, b) => valueOf(a) > valueOf(b) || (valueOf(a) === valueOf(b) && a.at < b.at);
    const best = [];
    for (const r of rows) {
        if (best.length === n && !better(r, best[n - 1])) continue;
        let i = best.length;
        while (i > 0 && better(r, best[i - 1])) i--;
        best.splice(i, 0, r);
        if (best.length > n) best.pop();
    }
    return best;
}

const bump = (map, key, by) => {
    const entry = map.get(key) ?? { total: 0, messages: 0 };
    entry.total += by;
    entry.messages += 1;
    map.set(key, entry);
};

// What the messages carrying one emoji add up to. rows: one per message, { id, channel_id, author_id,
// has_media, at (ms), total }. Weekdays (0 = Sunday) and hours are UTC, the clock the IDs are stamped in.
// Time is when the message was posted: reactions have no timestamp of their own
function summariseEmoji(rows) {
    const receivers = new Map();
    const channels = new Map();
    const months = new Map();
    const weekdays = new Array(7).fill(0);
    const hours = new Array(24).fill(0);
    let total = 0;
    let singles = 0;
    let media = 0;
    let first = null;
    let last = null;
    for (const r of rows) {
        total += r.total;
        if (r.total === 1) singles++;
        if (r.has_media) media++;
        bump(receivers, r.author_id, r.total);
        bump(channels, r.channel_id, r.total);
        const date = new Date(r.at);
        bump(months, date.toISOString().slice(0, 7), r.total);
        weekdays[date.getUTCDay()] += r.total;
        hours[date.getUTCHours()] += r.total;
        if (!first || r.at < first.at) first = r;
        if (!last || r.at > last.at) last = r;
    }
    return {
        total, messages: rows.length, singles, media, first, last, receivers, channels, weekdays, hours,
        months: [...months].map(([month, v]) => ({ month, ...v })).sort((a, b) => a.month < b.month ? -1 : 1),
        top: topRows(rows, TOP_MESSAGES, r => r.total)
    };
}

// The index of the biggest value, or -1 when they are all zero
function peakIndex(values) {
    const max = Math.max(...values);
    return max > 0 ? values.indexOf(max) : -1;
}

// Who gave an emoji to whom. pairs: { user_id, author_id, total } for each giver and receiver, with total
// the messages of the receiver's they used it on. Giving to yourself is counted apart, since the
// received numbers leave it out
function summarisePairs(pairs) {
    const givers = new Map();
    const fans = new Map();
    let self = 0;
    let top = null;
    for (const p of pairs) {
        if (p.user_id === p.author_id) {
            self += p.total;
            continue;
        }
        const giver = givers.get(p.user_id) ?? { total: 0, people: 0 };
        giver.total += p.total;
        giver.people += 1;
        givers.set(p.user_id, giver);
        fans.set(p.author_id, (fans.get(p.author_id) ?? 0) + 1);
        if (!top || p.total > top.total || (p.total === top.total && p.user_id + p.author_id < top.user_id + top.author_id)) top = p;
    }
    return { givers, fans, self, top };
}

// The entry of a Map of key -> { total, ... } with the highest total. Ties go to the lower key
function biggest(map, valueOf = (v) => v.total) {
    let best = null;
    for (const [key, v] of map) {
        if (!best || valueOf(v) > best.value || (valueOf(v) === best.value && key < best.key)) best = { key, value: valueOf(v), entry: v };
    }
    return best;
}

module.exports = {
    topRows, summariseEmoji, peakIndex, summarisePairs, biggest, TOP_MESSAGES, MIN_MAGNET_MESSAGES,
    wilson, monthRange, alignToMonths, runningTotal, spanOf, rankHaters, rankFans, pickTop, parseMonth, trimMonths,
    ratioSeries, shiftMonth, trendOf, peakMonth, MIN_HATER_TOTAL_DOWNVOTES, MIN_FAN_TOTAL_UPVOTES
};
