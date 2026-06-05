require('dotenv').config();

const { Client, Events, GatewayIntentBits } = require('discord.js');

const ADDED_REACT = process.env.ADDED_REACT ?? String.fromCodePoint(0x2795);
const DUPLICATE_REACT = process.env.DUPLICATE_REACT ?? String.fromCodePoint(0x267B);

const log = {
    timestamp: () => new Date().toISOString().replace('T', ' ').slice(0, 19),
    info:  (msg) => console.log(`[${log.timestamp()}] [INFO]  ${msg}`),
    warn:  (msg) => console.warn(`[${log.timestamp()}] [WARN]  ${msg}`),
    error: (msg) => console.error(`[${log.timestamp()}] [ERROR] ${msg}`),
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pending = new Map();

client.on(Events.ClientReady, () => {
    log.info('Online');
});

client.on(Events.MessageCreate, async (message) => {
    if (!message.author.bot && ['.np', '.fm'].includes(message.content.trim())) {
        const timeout = setTimeout(() => pending.delete(message.channelId), 10_000);
        pending.set(message.channelId, { timeout, user: message.author.username });
        return;
    }

    if (message.author.bot && pending.has(message.channelId)) {
        const { timeout } = pending.get(message.channelId);
        clearTimeout(timeout);
        pending.delete(message.channelId);

        const raw = message.toJSON();

        let song, artist, album;

        const container = raw.components?.[0];

        if (container?.type === 17) {
            const first = container?.components?.[0];
            const mainText = first?.type === 9
                ? first?.components?.[0]?.content ?? ''
                : first?.content ?? '';

            const lines = mainText.split('\n');

            // "Embed tiny" starts with **[Song], regular embed starts with -# Now playing
            const isTiny = lines[0].startsWith('**[');
            const songLine   = isTiny ? lines[0] : lines[1];
            const artistLine = isTiny ? lines[1] : lines[2];

            if (!songLine || !artistLine) {
                log.warn('Unexpected fmbot format: ' + JSON.stringify(raw.components, null, 2));
                return;
            }

            song = songLine.slice(songLine.indexOf('[') + 1, songLine.indexOf(']'));
            const [artistPart, albumPart] = artistLine.split(' • ');
            artist = artistPart.replaceAll('**', '');
            album  = albumPart?.replaceAll('*', '').replace('\\:', ':');
        } else {
            const lines = message.content.split('\n');

            if (lines[0].startsWith('**') && lines[1]?.startsWith('By ')) {
                // "Text" format: **Song**\nBy Artist | Album\n...
                song   = lines[0].replaceAll('**', '');
                artist = lines[1].slice(3, lines[1].indexOf(' |')).replaceAll('**', '');
                album  = lines[1].slice(lines[1].indexOf(' | ') + 3).replaceAll('*', '');
            } else {
                // "Text one-line" format: **User** is listening to **Song** by **Artist**
                const afterListening = message.content.split(' is listening to ')[1];
                if (!afterListening) {
                    log.warn('Unexpected fmbot text format: ' + message.content);
                    return;
                }
                const [songPart, artistPart] = afterListening.split(' by ');
                song   = songPart.replaceAll('**', '');
                artist = artistPart.replaceAll('**', '');
            }
        }

        try {
            const token = await getSpotifyToken();
            const trackUri = await searchTrack(token, song, artist, album);

            if (trackUri) {
                if (await isTrackInPlaylist(token, trackUri)) {
                    log.info(`Already in playlist: ${song} by ${artist}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await message.react(DUPLICATE_REACT);
                } else {
                    await addToPlaylist(token, trackUri);
                    log.info(`Added: ${song} by ${artist}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await message.react(ADDED_REACT);
                }
            } else {
                log.warn(`Not found on Spotify: ${song} by ${artist}`);
            }
        } catch (err) {
            log.error(`Spotify error for "${song}" by ${artist}: ${err.message}`);
        }
    }
});

async function getSpotifyToken() {
    const credentials = Buffer.from(
        `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: process.env.SPOTIFY_REFRESH_TOKEN
        })
    });

    const data = await response.json();
    return data.access_token;
}

async function searchTrack(token, song, artist, album) {
    const query = album
        ? `track:${song} artist:${artist} album:${album}`
        : `track:${song} artist:${artist}`;

    const response = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const data = await response.json();
    return data.tracks?.items?.[0]?.uri;
}

async function isTrackInPlaylist(token, trackUri) {
    let url = `https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_PLAYLIST_ID}/tracks?limit=100`;

    while (url) {
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();

        if (!data.items) {
            log.error('Unexpected playlist response: ' + JSON.stringify(data));
            return false;
        }

        if (data.items.some(item => item.track?.uri === trackUri)) return true;

        url = data.next;
    }

    return false;
}

async function addToPlaylist(token, trackUri) {
    await fetch(`https://api.spotify.com/v1/playlists/${process.env.SPOTIFY_PLAYLIST_ID}/tracks`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uris: [trackUri] })
    });
}

client.login(process.env.DISCORD_TOKEN);
