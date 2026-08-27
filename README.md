# WhatGram Realtime V1

A simple mobile-first realtime chat app.

## Features
- Account registration/login
- Username + password authentication
- User list/search
- One-to-one realtime messaging with WebSocket
- Message history
- SQLite database
- Responsive blue WhatGram UI
- Runs as one Node.js web service

## Local test
1. Install Node.js 20+.
2. Run `npm install`
3. Set `JWT_SECRET` to a long random value.
4. Run `npm start`
5. Open `http://localhost:3000`
6. Open a second browser/incognito window and create a second account.
7. Log in as the two users and send messages.

## Render
Create a new Web Service from this GitHub repository.
Build command: `npm install`
Start command: `npm start`

Environment variable:
`JWT_SECRET` = a long random secret.

IMPORTANT:
The included SQLite database is fine for a prototype/small test. For a production app with reliable persistent data, move the database to a managed PostgreSQL service before a large public launch.
