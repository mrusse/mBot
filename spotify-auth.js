require('dotenv').config();

const readline = require('readline');

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SCOPES = 'playlist-modify-public playlist-modify-private';

const authUrl = 'https://accounts.spotify.com/authorize'
    + '?response_type=code'
    + '&client_id=' + CLIENT_ID
    + '&scope=' + encodeURIComponent(SCOPES)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI);

console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nAfter logging in, your browser will show a connection error.');
console.log('Copy the full URL from the address bar and paste it here.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the redirect URL: ', async (input) => {
    rl.close();

    const code = new URL(input).searchParams.get('code');
    if (!code) {
        console.error('No code found in URL.');
        process.exit(1);
    }

    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI
        })
    });

    const data = await response.json();

    if (!data.refresh_token) {
        console.error('Failed to get refresh token:', data);
        process.exit(1);
    }

    const fs = require('fs');
    fs.appendFileSync('.env', `\nSPOTIFY_REFRESH_TOKEN=${data.refresh_token}\n`);

    console.log('\nSuccess! Refresh token saved to .env.');
});
