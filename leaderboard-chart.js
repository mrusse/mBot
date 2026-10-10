const { createCanvas, loadImage } = require('canvas');
const { Chart } = require('chart.js/auto');

const WIDTH = 1000;
const HEIGHT = 520;
const ICON_SIZE = 24;            // px, emote size in the legend
const ICON_TIMEOUT_MS = 4000;    // a slow CDN shouldn't hold up a reply that has already been deferred
const BACKGROUND = '#1e1f22';
const TEXT = '#dbdee1';
const GRID = '#3f4147';
const MAX_X_TICKS = 12;

// Hues spread far apart so ten lines stay tellable on a dark background
const PALETTE = [
    '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245',
    '#00b0f4', '#f48c2f', '#b57edc', '#1abc9c', '#e5e7eb'
];

// Chart.js leaves the canvas transparent, and Discord's themes would make the grey text unreadable on
// one of them. Painting before the chart draws gives every viewer the same dark panel
const backgroundPlugin = {
    id: 'background',
    beforeDraw(chart) {
        const { ctx, width, height } = chart;
        ctx.save();
        ctx.fillStyle = BACKGROUND;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    }
};

// Emote images by URL. A promise is cached so two lines using one emote share a single download; failures
// that may be temporary (network, timeout) are dropped so the next chart tries again, while a 404 stays
// cached as null since a deleted emote doesn't come back
const _icons = new Map();

async function downloadIcon(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const image = await loadImage(Buffer.from(await response.arrayBuffer()));
    // Chart.js draws a legend image at its natural size, so shrink it first. It only draws real Image
    // objects, hence the trip through a PNG buffer
    const small = createCanvas(ICON_SIZE, ICON_SIZE);
    small.getContext('2d').drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
    return loadImage(small.toBuffer('image/png'));
}

// Resolves to an Image, or null when there isn't one, so the legend falls back to a coloured swatch
function loadIcon(url) {
    if (!url) return Promise.resolve(null);
    if (!_icons.has(url)) {
        _icons.set(url, downloadIcon(url).catch(() => {
            _icons.delete(url);
            return null;
        }));
    }
    return _icons.get(url);
}

// Custom emotes have an ID in their <:name:id> text; standard emoji have no image to fetch
function emojiIconUrl(display) {
    const id = display?.match(/^<a?:\w+:(\d+)>$/)?.[1];
    return id ? `https://cdn.discordapp.com/emojis/${id}.png?size=48` : null;
}

// series: [{ label, values, iconUrl? }], values lining up with labels. Returns a PNG buffer
async function renderLineChart({ title, labels, series }) {
    const icons = await Promise.all(series.map(s => loadIcon(s.iconUrl)));
    const canvas = createCanvas(WIDTH, HEIGHT);
    // Chart.js reads canvas.style, which node-canvas doesn't have
    canvas.style = {};
    const defaultLabels = Chart.defaults.plugins.legend.labels.generateLabels;

    const chart = new Chart(canvas, {
        type: 'line',
        plugins: [backgroundPlugin],
        data: {
            labels,
            datasets: series.map((s, i) => ({
                label: s.label,
                data: s.values,
                borderColor: PALETTE[i % PALETTE.length],
                backgroundColor: PALETTE[i % PALETTE.length],
                borderWidth: 2.5,
                pointRadius: 0,
                tension: 0
            }))
        },
        options: {
            responsive: false,
            animation: false,
            color: TEXT,
            layout: { padding: 12 },
            plugins: {
                title: { display: true, text: title, color: TEXT, font: { size: 18 } },
                legend: {
                    labels: {
                        color: TEXT,
                        usePointStyle: true,
                        pointStyleWidth: ICON_SIZE,
                        font: { size: 14 },
                        // Emotes go on the legend only, with the name in the line's colour. The emote
                        // replaces the colour swatch, so without that nothing would say which line is which
                        generateLabels(chart) {
                            return defaultLabels(chart).map(item => {
                                const icon = icons[item.datasetIndex];
                                const labelled = { ...item, fontColor: PALETTE[item.datasetIndex % PALETTE.length] };
                                return icon ? { ...labelled, pointStyle: icon } : labelled;
                            });
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: TEXT, maxTicksLimit: MAX_X_TICKS, maxRotation: 0 }, grid: { color: GRID } },
                y: { beginAtZero: true, ticks: { color: TEXT }, grid: { color: GRID } }
            }
        }
    });
    try {
        return canvas.toBuffer('image/png');
    } finally {
        chart.destroy();
    }
}

module.exports = { renderLineChart, emojiIconUrl };
