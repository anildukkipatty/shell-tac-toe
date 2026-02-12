# Shell Tac Toe

A real-time multiplayer Tic-Tac-Toe game with strategic power-ups called **shells**. Place your coins, earn shells, and use them to outsmart your opponent.

**Place. Power Up. Prevail.**

## How It Works

Two players compete online in a game of Tic-Tac-Toe — but with a twist. Each time you place a coin, you earn a random shell power-up. On your turn, you can either place a coin or use a shell.

### Shells

| Shell | Effect |
|-------|--------|
| **Mine** | Place on an empty cell (hidden from opponent). If they land on it, all their coins are wiped from the board. |
| **Shovel** | Remove one of your opponent's coins from the board. |
| **Flip** | Convert an opponent's coin to yours. Cannot be used to complete a three-in-a-row. |

## Getting Started

### Prerequisites

- Node.js (v12+)

### Installation

```bash
npm install
npm start
```

The server starts on `http://localhost:3000`. One player creates a game and shares the 6-character game code, the other joins with it.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## Tech Stack

- **Backend:** Node.js with [ws](https://github.com/websockets/ws) for WebSockets
- **Frontend:** Vanilla HTML/CSS/JS (single-page app)
- **Deployment:** PM2 via `ecosystem.config.js`

## Features

- Real-time multiplayer via WebSockets
- Session persistence with automatic reconnection
- Rematch support
- In-game event log
- Copy-to-clipboard game codes
