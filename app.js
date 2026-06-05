require('dotenv').config();

const { Client, Events, GatewayIntentBits } = require('discord.js');

const ADDED_REACT = process.env.ADDED_REACT ?? String.fromCodePoint(0x2795);
const DUPLICATE_REACT = process.env.DUPLICATE_REACT ?? String.fromCodePoint(0x267B);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const pending = new Map();

client.on(Events.ClientReady, () => {
    console.log('Online');
});

client.on(Events.MessageCreate, async (message) => {
    if (!message.author.bot && message.content.trim() === '.np') {
        const timeout = setTimeout(() => pending.delete(message.channelId), 10_000);
        pending.set(message.channelId, { timeout, user: message.author.username });
        return;
    }

    if (message.author.bot && pending.has(message.channelId)) {
        const { timeout } = pending.get(message.channelId);
        clearTimeout(timeout);
        pending.delete(message.channelId);

        const raw = message.toJSON();

        const container = raw.components?.[0];
        const first = container?.components?.[0];
        const mainText = first?.type === 9
            ? first?.components?.[0]?.content ?? ''
            : first?.content ?? '';

        const lines = mainText.split('\n');

        if (!lines[1] || !lines[2]) {
            console.log('Unexpected fmbot format:', JSON.stringify(raw.components, null, 2));
            return;
        }

        const song = lines[1].slice(lines[1].indexOf('[') + 1, lines[1].indexOf(']'));
        const [artistPart, albumPart] = lines[2].split(' • ');
        const artist = artistPart.replaceAll('**', '');
        const album = albumPart.replaceAll('*', '').replace('\\:', ':');

        try {
            const token = await getSpotifyToken();
            const trackUri = await searchTrack(token, song, artist);

            if (trackUri) {
                if (await isTrackInPlaylist(token, trackUri)) {
                    console.log(`Already in playlist: ${song} by ${artist}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await message.react(DUPLICATE_REACT);
                } else {
                    await addToPlaylist(token, trackUri);
                    console.log(`Added: ${song} by ${artist}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await message.react(ADDED_REACT);
                }
            } else {
                console.log(`Not found on Spotify: ${song} by ${artist}`);
            }
        } catch (err) {
            console.error(`Spotify error for "${song}" by ${artist}:`, err.message);
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

async function searchTrack(token, song, artist) {
    const query = `track:${song} artist:${artist}`;

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
            console.error('Unexpected playlist response:', JSON.stringify(data));
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
