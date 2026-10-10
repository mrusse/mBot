// Pure maths for the vote commands. No database or Discord in here, so it can be tested on its own

const WILSON_Z = 1.96;           // 95% confidence
const MIN_BASELINE_SHARE = 0.001; // a baseline of zero would make any downvote look infinitely hateful
const MIN_BASELINE_VOTES = 20;   // votes elsewhere needed before a voter's usual rate means anything
const MIN_HATER_DOWNVOTES = 3;   // downvotes on someone before it can be called a pattern

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

// Voters ranked by how much more they downvote one person than they do everyone else.
// onYou: rows of { user_id, is_up, total } for the person. habits: Map of user ID -> { up_given, down_given }
// over everything they voted on. Voters are compared with their own rate elsewhere, so someone who
// downvotes everybody a lot doesn't top the list for being harsh
function rankHaters(onYou, habits) {
    const votes = new Map();
    for (const r of onYou) {
        const entry = votes.get(r.user_id) ?? { up: 0, down: 0 };
        entry[r.is_up ? 'up' : 'down'] += r.total;
        votes.set(r.user_id, entry);
    }
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
            votes: onYouVotes,
            lift: down / onYouVotes / baseline,
            score: wilson(down, onYouVotes)[0] / baseline
        });
    }
    return ranked.sort((a, b) => b.score - a.score);
}

module.exports = {
    wilson, monthRange, alignToMonths, runningTotal, spanOf, rankHaters, parseMonth, trimMonths, ratioSeries
};
