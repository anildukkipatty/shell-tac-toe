const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const games = new Map();
const CLEANUP_DELAY = 180000; // 3 minutes

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

function generateUserId() {
  return crypto.randomBytes(16).toString('hex');
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

const SHELL_TYPES = ['mine', 'shovel', 'flip'];

function generateRandomShell() {
  return SHELL_TYPES[Math.floor(Math.random() * SHELL_TYPES.length)];
}

function createGameState(id) {
  return {
    id,
    board: Array(9).fill(0),
    shells: { X: [], O: [] },
    mines: { X: [], O: [] },
    currentTurn: null,
    players: { X: null, O: null },
    gameOver: false,
    firstPlayer: null,
    winner: null,
    winCells: null,
    restartVotes: { X: false, O: false },
  };
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

function buildGameState(game, forSymbol) {
  const oppSymbol = opponent(forSymbol);
  return {
    type: 'gameState',
    board: game.board,
    currentTurn: game.currentTurn,
    gameOver: game.gameOver,
    yourSymbol: forSymbol,
    yourShells: game.shells[forSymbol],
    opponentShellCount: game.shells[oppSymbol].length,
    yourMines: game.mines[forSymbol],
    players: {
      X: game.players.X ? game.players.X.username : null,
      O: game.players.O ? game.players.O.username : null,
    },
  };
}

function broadcastState(game) {
  for (const sym of ['X', 'O']) {
    if (game.players[sym] && game.players[sym].ws) {
      sendJSON(game.players[sym].ws, buildGameState(game, sym));
    }
  }
}

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
    shells: game.shells,
    mines: game.mines,
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

  const boardFull = game.board.every(c => c !== 0);
  if (boardFull) {
    broadcastGameOver(game, null, null, 'draw');
    return true;
  }

  return false;
}

function tryCleanupGame(gameId) {
  const game = games.get(gameId);
  if (!game) return;
  const xConn = game.players.X && game.players.X.ws && game.players.X.ws.readyState === 1;
  const oConn = game.players.O && game.players.O.ws && game.players.O.ws.readyState === 1;
  if (!xConn && !oConn) {
    games.delete(gameId);
  }
}

function advanceTurn(game) {
  game.currentTurn = opponent(game.currentTurn);
  broadcastState(game);
}

// Process a single coin placement, checking for mines. Returns info about what happened.
function processPlacement(game, symbol, cell) {
  const opp = opponent(symbol);
  const mineIndex = game.mines[opp].indexOf(cell);

  if (mineIndex !== -1) {
    // Mine triggered — wipe all of this player's coins
    for (let i = 0; i < 9; i++) {
      if (game.board[i] === symbol) {
        game.board[i] = 0;
      }
    }
    game.mines[opp].splice(mineIndex, 1);
    // Cell stays empty
    return { mineTriggered: true };
  } else {
    game.board[cell] = symbol;
    return { mineTriggered: false };
  }
}

wss.on('connection', (ws) => {
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
        const userId = msg.userId || generateUserId();
        const gameId = generateId();
        const game = createGameState(gameId);

        const creatorSymbol = Math.random() < 0.5 ? 'X' : 'O';
        game.players[creatorSymbol] = { ws, username, userId };
        games.set(gameId, game);
        ws._gameId = gameId;
        ws._symbol = creatorSymbol;
        ws._userId = userId;

        sendJSON(ws, { type: 'created', gameId, symbol: creatorSymbol, userId });
        break;
      }

      case 'join': {
        const gameId = (msg.gameId || '').toString().toUpperCase().trim();
        const username = (msg.username || 'Player').toString().slice(0, 20);
        const userId = msg.userId || generateUserId();
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
        game.players[joinerSymbol] = { ws, username, userId };
        ws._gameId = gameId;
        ws._symbol = joinerSymbol;
        ws._userId = userId;

        game.firstPlayer = Math.random() < 0.5 ? 'X' : 'O';
        game.currentTurn = game.firstPlayer;

        for (const sym of ['X', 'O']) {
          if (game.players[sym] && game.players[sym].ws) {
            sendJSON(game.players[sym].ws, {
              type: 'started',
              symbol: sym,
              gameId,
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
        const game = games.get(ws._gameId);
        const symbol = ws._symbol;
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }

        const cell = parseInt(msg.cell);
        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== 0) { sendError(ws, 'Cell is occupied'); return; }

        const opp = opponent(symbol);
        const result = processPlacement(game, symbol, cell);
        const newShell = generateRandomShell();
        game.shells[symbol].push(newShell);

        if (result.mineTriggered) {
          sendJSON(ws, { type: 'actionResult', action: 'place', cell, success: false,
                         reason: 'mine', newShell });
          if (game.players[opp] && game.players[opp].ws) {
            sendJSON(game.players[opp].ws, { type: 'actionResult', action: 'mineTriggered',
                                              cell, victim: symbol });
          }
        } else {
          sendJSON(ws, { type: 'actionResult', action: 'place', cell, success: true, newShell });
        }

        if (checkGameEnd(game)) return;
        advanceTurn(game);
        break;
      }

      case 'useMine': {
        const game = games.get(ws._gameId);
        const symbol = ws._symbol;
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }

        const mineIdx = game.shells[symbol].indexOf('mine');
        if (mineIdx === -1) { sendError(ws, 'You have no Mine shell'); return; }

        const cell = parseInt(msg.cell);
        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== 0) { sendError(ws, 'Cell must be empty'); return; }
        if (game.mines[symbol].includes(cell) || game.mines[opponent(symbol)].includes(cell)) {
          sendError(ws, 'Cell already has a mine');
          return;
        }

        game.shells[symbol].splice(mineIdx, 1);
        game.mines[symbol].push(cell);

        sendJSON(ws, { type: 'actionResult', action: 'useMine', cell, success: true });
        advanceTurn(game);
        break;
      }

      case 'useShovel': {
        const game = games.get(ws._gameId);
        const symbol = ws._symbol;
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }

        const shovelIdx = game.shells[symbol].indexOf('shovel');
        if (shovelIdx === -1) { sendError(ws, 'You have no Shovel shell'); return; }

        const cell = parseInt(msg.cell);
        const opp = opponent(symbol);
        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== opp) { sendError(ws, 'Not an opponent cell'); return; }

        game.shells[symbol].splice(shovelIdx, 1);
        game.board[cell] = 0;

        sendJSON(ws, { type: 'actionResult', action: 'useShovel', cell, success: true });
        if (game.players[opp] && game.players[opp].ws) {
          sendJSON(game.players[opp].ws, { type: 'actionResult', action: 'opponentShovel', cell });
        }

        advanceTurn(game);
        break;
      }

      case 'useFlip': {
        const game = games.get(ws._gameId);
        const symbol = ws._symbol;
        if (!game) { sendError(ws, 'No game'); return; }
        if (game.gameOver) { sendError(ws, 'Game is over'); return; }
        if (game.currentTurn !== symbol) { sendError(ws, 'Not your turn'); return; }

        const flipIdx = game.shells[symbol].indexOf('flip');
        if (flipIdx === -1) { sendError(ws, 'You have no Flip shell'); return; }

        const cell = parseInt(msg.cell);
        const opp = opponent(symbol);
        if (isNaN(cell) || cell < 0 || cell > 8) { sendError(ws, 'Invalid cell'); return; }
        if (game.board[cell] !== opp) { sendError(ws, 'Not an opponent cell'); return; }

        // Simulate flip and check if it would win
        game.board[cell] = symbol;
        const wouldWin = checkWin(game.board);
        game.board[cell] = opp; // revert
        if (wouldWin && wouldWin.winner === symbol) {
          sendJSON(ws, { type: 'actionResult', action: 'useFlip', cell, success: false, reason: 'wouldWin' });
          return;
        }

        game.shells[symbol].splice(flipIdx, 1);
        game.board[cell] = symbol;

        sendJSON(ws, { type: 'actionResult', action: 'useFlip', cell, success: true });
        if (game.players[opp] && game.players[opp].ws) {
          sendJSON(game.players[opp].ws, { type: 'actionResult', action: 'opponentFlip', cell });
        }

        if (checkGameEnd(game)) return;
        advanceTurn(game);
        break;
      }

      case 'restart': {
        const game = games.get(ws._gameId);
        const symbol = ws._symbol;
        if (!game) { sendError(ws, 'No game'); return; }
        if (!game.gameOver) { sendError(ws, 'Game is not over'); return; }

        game.restartVotes[symbol] = true;
        const opp = opponent(symbol);

        // Notify opponent
        if (game.players[opp] && game.players[opp].ws) {
          sendJSON(game.players[opp].ws, { type: 'opponentWantsRestart' });
        }

        // Both voted — reset the game
        if (game.restartVotes.X && game.restartVotes.O) {
          // Optionally swap symbols
          const swap = Math.random() < 0.5;
          if (swap) {
            const tmpPlayer = game.players.X;
            game.players.X = game.players.O;
            game.players.O = tmpPlayer;
            // Update ws metadata
            for (const sym of ['X', 'O']) {
              if (game.players[sym] && game.players[sym].ws) {
                game.players[sym].ws._symbol = sym;
              }
            }
          }

          game.board = Array(9).fill(0);
          game.shells = { X: [], O: [] };
          game.mines = { X: [], O: [] };
          game.gameOver = false;
          game.winner = null;
          game.winCells = null;
          game.restartVotes = { X: false, O: false };
          game.firstPlayer = Math.random() < 0.5 ? 'X' : 'O';
          game.currentTurn = game.firstPlayer;

          for (const sym of ['X', 'O']) {
            if (game.players[sym] && game.players[sym].ws) {
              sendJSON(game.players[sym].ws, {
                type: 'restarted',
                symbol: sym,
                gameId: game.id,
                opponentName: game.players[opponent(sym)].username,
                yourUsername: game.players[sym].username,
                firstTurn: game.firstPlayer,
              });
            }
          }

          broadcastState(game);
        }

        break;
      }

      case 'reconnect': {
        const gameId = (msg.gameId || '').toString().toUpperCase().trim();
        const userId = (msg.userId || '').toString();
        const game = games.get(gameId);

        if (!game) {
          sendJSON(ws, { type: 'reconnectFailed', reason: 'Game not found' });
          return;
        }

        // Find which symbol this userId belongs to
        let reconnectSymbol = null;
        for (const sym of ['X', 'O']) {
          if (game.players[sym] && game.players[sym].userId === userId) {
            reconnectSymbol = sym;
            break;
          }
        }

        if (!reconnectSymbol) {
          sendJSON(ws, { type: 'reconnectFailed', reason: 'Not a player in this game' });
          return;
        }

        // Close old socket if still connected
        const oldWs = game.players[reconnectSymbol].ws;
        if (oldWs && oldWs !== ws && oldWs.readyState === 1) {
          sendJSON(oldWs, { type: 'kicked', reason: 'Reconnected from another tab' });
          oldWs._gameId = null;
          oldWs.close();
        }

        // Re-attach new socket
        game.players[reconnectSymbol].ws = ws;
        ws._gameId = gameId;
        ws._symbol = reconnectSymbol;
        ws._userId = userId;

        const opp = opponent(reconnectSymbol);
        const oppPlayer = game.players[opp];

        sendJSON(ws, {
          type: 'reconnected',
          symbol: reconnectSymbol,
          gameId,
          opponentName: oppPlayer ? oppPlayer.username : null,
          yourUsername: game.players[reconnectSymbol].username,
          gameStarted: !!(game.currentTurn),
        });

        // Notify opponent that the player is back
        if (oppPlayer && oppPlayer.ws) {
          sendJSON(oppPlayer.ws, { type: 'opponentReconnected' });
        }

        // Send current game state if game has started
        if (game.currentTurn || game.gameOver) {
          sendJSON(ws, buildGameState(game, reconnectSymbol));
          if (game.gameOver) {
            sendJSON(ws, {
              type: 'gameOver',
              winner: game.winner,
              winCells: game.winCells,
              reason: 'reconnect_reveal',
              board: game.board,
              shells: game.shells,
              mines: game.mines,
              players: {
                X: game.players.X ? game.players.X.username : null,
                O: game.players.O ? game.players.O.username : null,
              },
              yourSymbol: reconnectSymbol,
            });
          }
        }

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

    if (game.players[symbol]) {
      game.players[symbol].ws = null;
    }

    setTimeout(() => tryCleanupGame(gameId), CLEANUP_DELAY);
  });
});

server.listen(PORT, () => {
  console.log(`Shell Tac Toe server running on port ${PORT}`);
});
