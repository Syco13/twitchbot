require('dotenv').config();
const { ApiClient } = require('@twurple/api');
const { AppTokenAuthProvider } = require('@twurple/auth');

// Debug: Print environment variables (without showing full secrets)
console.log('Client ID length:', process.env.TWITCH_CLIENT_ID?.length || 0);
console.log('Client Secret length:', process.env.TWITCH_CLIENT_SECRET?.length || 0);

async function getStreamerId(username) {
    if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        console.error('Error: Missing Twitch credentials in .env file');
        console.error('Please make sure TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are set');
        return null;
    }

    const authProvider = new AppTokenAuthProvider(
        process.env.TWITCH_CLIENT_ID,
        process.env.TWITCH_CLIENT_SECRET
    );

    const twitchClient = new ApiClient({ authProvider });

    try {
        console.log(`Attempting to fetch user: ${username}`);
        const user = await twitchClient.users.getUserByName(username);
        if (user) {
            console.log(`Streamer ID for ${username}: ${user.id}`);
            return user.id;
        } else {
            console.log(`No user found with username: ${username}`);
            return null;
        }
    } catch (error) {
        console.error('Detailed error information:');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        return null;
    }
}

// Get username from command line argument
const username = process.argv[2];
if (!username) {
    console.log('Please provide a Twitch username as an argument');
    console.log('Example: node get-streamer-id.js username');
    process.exit(1);
}

getStreamerId(username); 