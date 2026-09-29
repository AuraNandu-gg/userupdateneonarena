# Neon Arena — Railway Ready

Real-time multiplayer browser arena built with Node.js, Express and Socket.IO.

## Features
- Multiplayer rooms with room codes
- Real-time movement, aiming and shooting
- Room and global chat
- Friend requests, friends and room invites
- Unique usernames (case-insensitive)
- Permanent user IDs for friendships
- Browser account token so another player cannot claim an existing username
- One active session per account
- Match scoreboard and persistent leaderboard

## Run locally
```bash
npm install
npm start
```

## Railway
1. Upload this project to a GitHub repository.
2. Create a new Railway service from that GitHub repository.
3. Railway should detect the Node.js project automatically.
4. Build command: `npm install`
5. Start command: `npm start`
6. Deploy.

The server listens on Railway's `PORT` environment variable automatically.

### Username system
The first browser that creates a username receives a random account ID and authentication token. The username is unique in the SQLite database using a case-insensitive constraint. Friends and friend requests use the permanent user ID, not the display name.

If an old database from a previous Neon Arena build is reused, accounts that were created before the authentication-token upgrade may need new usernames because the old version did not have account credentials.
