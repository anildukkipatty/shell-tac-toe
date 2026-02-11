const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const games = new Map();

// --- HTTP server: serve static files from public/ ---
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server });

function generateId() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

function checkWin(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] !== 0 && board[a] === board[b] && board[b] === board[c]) {
      return { winner: board[a], cells: [a, b, c] };
    }
  }
  return null;
}

function createGameState(id) {
  return {
    id,
    board: Array(9).fill(0),
    bids: Array(9).fill(0),
    money: { X: 100, O: 100 },
    currentTurn: null,
    turnState: { placed: false, removed: false },
    players: { X: null, O: null },
    gameOver: false,
    firstPlayer: null,
    winner: null,
    winCells: null,
  };
}

function getPlayerSymbol(game, ws) {
  if (game.players.X && game.players.X.ws === ws) return 'X';
  if (game.players.O && game.players.O.ws === ws) return 'O';
  return null;
}

function opponent(sym) {
  return sym === 'X' ? 'O' : 'X';
}

function sendJSON(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function sendError(ws, message) {
  sendJSON(ws, { type: 'error', message });
}

// Build a game state payload tailored for a specific player (hides opponent bids)
function buildGameState(game, forSymbol) {
  const visibleBids = Array(9).fill(null);
  for (let i = 0; i < 9; i++) {
    if (game.board[i] === forSymbol) {
      visibleBids[i] = game.bids[i];
    } else if (game.board[i] !== 0) {
      visibleBids[i] = '?'; // opponent's bid is hidden
    }
  }

  return {
    type: 'gameState',
    board: game.board,
    bids: visibleBids,
    money: { [forSymbol]: game.money[forSymbol] },
    currentTurn: game.currentTurn,
    turnState: game.currentTurn === forSymbol ? game.turnState : null,
    gameOver: game.gameOver,
    yourSymbol: forSymbol,
    players: {
      X: game.players.X ? game.players.X.username : null,
      O: game.players.O ? game.players.O.username : null,
    },
  };
}

// Send full state to both players (each sees their own bids only)
function broadcastState(game) {
  for (const sym of ['X', 'O']) {
    if (game.players[sym] && game.players[sym].ws) {
      sendJSON(game.players[sym].ws, buildGameState(game, sym));
    }
  }
}

// Send game over with all bids revealed
function broadcastGameOver(game, winner, winCells, reason) {
  game.gameOver = true;
  game.winner = winner;
  game.winCells = winCells;

  const payload = {
    type: 'gameOver',
    winner,
    winCells,
    reason,
    board: game.board,
    bids: game.bids, // reveal all bids
    money: game.money,
    players: {
      X: game.players.X ? game.players.X.username : null,
      O: game.players.O ? game.players.O.username : null,
    },
  };

  for (const sym of ['X', 'O']) {
    if (game.players[sym] && game.players[sym].ws) {
      sendJSON(game.players[sym].ws, { ...payload, yourSymbol: sym });
    }
  }
}

function checkGameEnd(game) {
  const win = checkWin(game.board);
  if (win) {
    broadcastGameOver(game, win.winner, win.cells, 'three_in_a_row');
    return true;
  }

  // Both bankrupt and board full
  const boardFull = game.board.every(c => c !== 0);
  if (game.money.X <= 0 && game.money.O <= 0 && boardFull) {
    broadcastGameOver(game, null, null, 'draw');
    return true;
  }

  return false;
}

// Clean up game if both players disconnected
function tryCleanupGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const xConn = game.players.X && game.players.X.ws && game.players.X.ws.readyState === 1;
  const oConn = game.players.O && game.players.O.ws && game.players.O.ws.readyState === 1;
  if (!xConn && !oConn) {
    games.delete(gameId);
  }
}

wss.on('connection', (ws) => {
  let playerGameId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendError(ws, 'Invalid JSON');
      return;
    }

    switch (msg.type) {
      case 'create': {
        const username = (msg.username || 'Player').toString().slice(0, 20);
        const gameId = generateId();
        const game = createGameState(gameId);

        // Creator gets a random symbol
        const creatorSymbol = Math.random() < 0.5 ? 'X' : 'O';
        game.players[creatorSymbol] = { ws, username };
        games.set(gameId, game);
        playerGameId = gameId;
        ws._gameId = gameId;
        ws._symbol = creatorSymbol;

        sendJSON(ws, { type: 'created', gameId, symbol: creatorSymbol });
        break;
      }

      case 'join': {
        const gameId = (msg.gameId || '').toString().toUpperCase().trim();
        const username = (msg.username || 'Player').toString().slice(0, 20);
        const game = games.get(gameId);

        if (!game) {
          sendError(ws, 'Game not found');
          return;
        }
        if (game.players.X && game.players.O) {
          sendError(ws, 'Game is full');
          return;
        }

        const joinerSymbol = game.players.X ? 'O' : 'X';
        game.players[joinerSymbol] = { ws, username };
        playerGameId = gameId;
        ws._gameId = gameId;
        ws._symbol = joinerSymbol;

        // Decide who goes first
        game.firstPlayer = Math.random() < 0.5 ? 'X' : 'O';
        game.currentTurn = game.firstPlayer;

        // Notify both players the game has started
        for (const sym of ['X', 'O']) {
          if (game.players[sym] && game.players[sym].ws) {
            sendJSON(game.players[sym].ws, {
              type: 'started',
              symbol: sym,
              opponentName: game.players[opponent(sym)].username,
              firstTurn: game.firstPlayer,
              yourUsername: game.players[sym].username,
            });
          }
        }

        broadcastState(game);
        break;
      }

      case 'place': {
        const gameId = ws._gameId;
        const symbol = ws._symbol;
        const game = games.get(gameId);
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }
        if (game.turnState.placed) { sendError(ws, 'Already placed this turn'); return; }

        const cell = parseInt(msg.cell);
        const bid = parseInt(msg.bid);

        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== 0) { sendError(ws, 'Cell is occupied'); return; }
        if (isNaN(bid) || bid < 1) { sendError(ws, 'Minimum bid is $1'); return; }
        if (bid > game.money[symbol]) { sendError(ws, 'Not enough money'); return; }

        game.board[cell] = symbol;
        game.bids[cell] = bid;
        game.money[symbol] -= bid;
        game.turnState.placed = true;

        sendJSON(ws, { type: 'actionResult', action: 'place', cell, bid, success: true });

        if (checkGameEnd(game)) return;

        // Auto end turn if both actions used or no money left
        if ((game.turnState.placed && game.turnState.removed) || game.money[symbol] <= 0) {
          advanceTurn(game);
        } else {
          broadcastState(game);
        }
        break;
      }

      case 'remove': {
        const gameId = ws._gameId;
        const symbol = ws._symbol;
        const game = games.get(gameId);
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }
        if (game.turnState.removed) { sendError(ws, 'Already tried a remove this turn'); return; }

        const cell = parseInt(msg.cell);
        const bid = parseInt(msg.bid);
        const opp = opponent(symbol);

        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== opp) { sendError(ws, 'Not an opponent cell'); return; }
        if (isNaN(bid) || bid < 1) { sendError(ws, 'Minimum bid is $1'); return; }
        if (bid > game.money[symbol]) { sendError(ws, 'Not enough money'); return; }

        const opponentBid = game.bids[cell];
        game.money[symbol] -= bid;
        game.turnState.removed = true;

        if (bid > opponentBid) {
          game.board[cell] = 0;
          game.bids[cell] = 0;
          sendJSON(ws, { type: 'actionResult', action: 'remove', cell, bid, success: true, opponentBid });
        } else {
          sendJSON(ws, { type: 'actionResult', action: 'remove', cell, bid, success: false, opponentBid });
        }

        if (checkGameEnd(game)) return;

        // Auto end turn if both actions used or no money left
        if ((game.turnState.placed && game.turnState.removed) || game.money[symbol] <= 0) {
          advanceTurn(game);
        } else {
          broadcastState(game);
        }
        break;
      }

      case 'endTurn': {
        const gameId = ws._gameId;
        const symbol = ws._symbol;
        const game = games.get(gameId);
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }
        if (!game.turnState.placed && !game.turnState.removed) {
          sendError(ws, 'Must take at least one action');
          return;
        }

        advanceTurn(game);
        break;
      }

      default:
        sendError(ws, 'Unknown message type');
    }
  });

  ws.on('close', () => {
    const gameId = ws._gameId;
    if (!gameId) return;
    const game = games.get(gameId);
    if (!game) return;

    const symbol = ws._symbol;
    const opp = opponent(symbol);

    if (game.players[opp] && game.players[opp].ws) {
      sendJSON(game.players[opp].ws, { type: 'opponentDisconnected' });
    }

    // Mark this player's ws as null
    if (game.players[symbol]) {
      game.players[symbol].ws = null;
    }

    // Clean up if both gone
    setTimeout(() => tryCleanupGame(gameId), 5000);
  });
});

function advanceTurn(game) {
  game.turnState = { placed: false, removed: false };
  game.currentTurn = opponent(game.currentTurn);

  // Check if next player is bankrupt and board is full — they can't do anything
  const nextSym = game.currentTurn;
  if (game.money[nextSym] <= 0) {
    // Check if there's any possible action: needs empty cell to place or opponent cell to remove
    const canPlace = game.board.some(c => c === 0);
    const canRemove = game.board.some(c => c === opponent(nextSym));
    if (!canPlace && !canRemove) {
      broadcastGameOver(game, null, null, 'draw');
      return;
    }
    // If bankrupt and no cells to interact with, skip or end
    if (!canPlace && !canRemove) {
      broadcastGameOver(game, null, null, 'draw');
      return;
    }
  }

  broadcastState(game);
}

server.listen(PORT, () => {
  console.log(`Bid Tac Toe server running on port ${PORT}`);
});
