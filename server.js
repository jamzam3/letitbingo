const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// Serve the game at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'LetItBinGo.html'));
});

// ---- GAME STATE ----
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPhrasesForPlayer(room, index) {
  const totalCells = room.boardSize * room.boardSize - 1;
  const base = Math.floor(totalCells / room.players.length);
  const remainder = totalCells % room.players.length;
  return index < remainder ? base + 1 : base;
}

function getRoomState(room) {
  return {
    code: room.code,
    boardSize: room.boardSize,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      phrasesSubmitted: p.phrases.length,
      phrasesNeeded: 0,
      ready: p.ready,
      won: p.won
    }))
  };
}

function broadcastLobby(room) {
  const state = getRoomState(room);
  // Calculate phrases needed per player
  const totalCells = room.boardSize * room.boardSize - 1;
  const playerCount = room.players.length;
  const base = Math.floor(totalCells / playerCount);
  const remainder = totalCells % playerCount;
  state.players.forEach((p, i) => {
    p.phrasesNeeded = i < remainder ? base + 1 : base;
  });
  io.to(room.code).emit('room-update', state);
}

// ---- SOCKET HANDLERS ----
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayer = null;

  socket.on('create-room', ({ playerName, boardSize }) => {
    const code = generateRoomCode();
    const room = {
      code,
      boardSize: boardSize || 5,
      phase: 'lobby', // lobby → phrases → game
      hostId: socket.id,
      players: [],
      allPhrases: []
    };

    const player = {
      id: socket.id,
      name: playerName,
      phrases: [],
      card: [],
      stamped: [],
      ready: false,
      won: false,
      winLine: null
    };

    room.players.push(player);
    rooms.set(code, room);
    socket.join(code);
    currentRoom = room;
    currentPlayer = player;

    socket.emit('room-joined', { code, playerId: socket.id, isHost: true });
    broadcastLobby(room);
  });

  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) {
      socket.emit('error-msg', 'Room not found.');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error-msg', 'Game already in progress.');
      return;
    }
    if (room.players.length >= 8) {
      socket.emit('error-msg', 'Room is full.');
      return;
    }
    if (room.players.some(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      socket.emit('error-msg', 'Name already taken in this room.');
      return;
    }

    const player = {
      id: socket.id,
      name: playerName,
      phrases: [],
      card: [],
      stamped: [],
      ready: false,
      won: false,
      winLine: null
    };

    room.players.push(player);
    socket.join(code);
    currentRoom = room;
    currentPlayer = player;

    socket.emit('room-joined', { code, playerId: socket.id, isHost: false });
    broadcastLobby(room);
  });

  socket.on('update-board-size', (size) => {
    if (!currentRoom || currentRoom.hostId !== socket.id) return;
    if (currentRoom.phase !== 'lobby') return;
    currentRoom.boardSize = Math.max(3, Math.min(7, size));
    broadcastLobby(currentRoom);
  });

  socket.on('start-phrases', () => {
    if (!currentRoom || currentRoom.hostId !== socket.id) return;
    if (currentRoom.players.length < 2) {
      socket.emit('error-msg', 'Need at least 2 players.');
      return;
    }
    currentRoom.phase = 'phrases';
    // Reset all phrase data
    currentRoom.players.forEach(p => {
      p.phrases = [];
      p.ready = false;
    });
    broadcastLobby(currentRoom);
  });

  socket.on('submit-phrases', (phrases) => {
    if (!currentRoom || !currentPlayer) return;
    if (currentRoom.phase !== 'phrases') return;

    const playerIndex = currentRoom.players.indexOf(currentPlayer);
    const needed = getPhrasesForPlayer(currentRoom, playerIndex);

    // Validate
    if (!Array.isArray(phrases) || phrases.length !== needed) {
      socket.emit('error-msg', `Please submit exactly ${needed} phrases.`);
      return;
    }

    const sanitized = phrases.map(p => String(p).trim().slice(0, 80)).filter(p => p.length > 0);
    if (sanitized.length !== needed) {
      socket.emit('error-msg', 'All phrases must be non-empty.');
      return;
    }

    currentPlayer.phrases = sanitized;
    currentPlayer.ready = true;
    broadcastLobby(currentRoom);

    // Check if all players ready
    if (currentRoom.players.every(p => p.ready)) {
      generateCards(currentRoom);
    }
  });

  socket.on('stamp-cell', (index) => {
    if (!currentRoom || !currentPlayer) return;
    if (currentRoom.phase !== 'game') return;
    if (currentPlayer.won) return;

    const boardTotal = currentRoom.boardSize * currentRoom.boardSize;
    const freeIndex = Math.floor(boardTotal / 2);
    if (index < 0 || index >= boardTotal || index === freeIndex) return;

    currentPlayer.stamped[index] = !currentPlayer.stamped[index];

    // Check win
    const winLine = checkWin(currentRoom.boardSize, currentPlayer.stamped);
    if (winLine) {
      currentPlayer.won = true;
      currentPlayer.winLine = winLine;
      io.to(currentRoom.code).emit('player-won', {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        winLine
      });
    }

    // Send updated stamp state back to this player only
    socket.emit('stamp-update', {
      stamped: currentPlayer.stamped,
      won: currentPlayer.won,
      winLine: currentPlayer.winLine
    });

    // Broadcast updated player status (won state) to all
    broadcastLobby(currentRoom);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const idx = currentRoom.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;

    currentRoom.players.splice(idx, 1);

    if (currentRoom.players.length === 0) {
      rooms.delete(currentRoom.code);
      return;
    }

    // If host left, assign new host
    if (currentRoom.hostId === socket.id) {
      currentRoom.hostId = currentRoom.players[0].id;
    }

    broadcastLobby(currentRoom);

    // If in phrases phase, check if remaining players are all ready
    if (currentRoom.phase === 'phrases' && currentRoom.players.every(p => p.ready)) {
      generateCards(currentRoom);
    }
  });
});

function generateCards(room) {
  // Pool all phrases, deduplicate
  const allPhrases = [...new Set(room.players.flatMap(p => p.phrases))];
  room.allPhrases = allPhrases;

  const boardTotal = room.boardSize * room.boardSize;
  const freeIndex = Math.floor(boardTotal / 2);
  const totalCells = boardTotal - 1;

  room.players.forEach(p => {
    const shuffled = shuffle(allPhrases);
    const picked = shuffled.slice(0, totalCells);
    p.card = [...picked.slice(0, freeIndex), 'FREE', ...picked.slice(freeIndex, totalCells)];
    p.stamped = new Array(boardTotal).fill(false);
    p.stamped[freeIndex] = true;
    p.won = false;
    p.winLine = null;
  });

  room.phase = 'game';

  // Send each player their own card
  room.players.forEach(p => {
    io.to(p.id).emit('game-start', {
      card: p.card,
      stamped: p.stamped,
      boardSize: room.boardSize
    });
  });

  broadcastLobby(room);
}

function checkWin(boardSize, stamped) {
  const n = boardSize;
  const lines = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(r * n + c);
    lines.push(row);
  }
  for (let c = 0; c < n; c++) {
    const col = [];
    for (let r = 0; r < n; r++) col.push(r * n + c);
    lines.push(col);
  }
  const d1 = [], d2 = [];
  for (let i = 0; i < n; i++) {
    d1.push(i * n + i);
    d2.push(i * n + (n - 1 - i));
  }
  lines.push(d1, d2);

  for (const line of lines) {
    if (line.every(i => stamped[i])) return line;
  }
  return null;
}

// ---- START ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`LetItBinGo! server running on http://localhost:${PORT}`);
  // Show local network IP
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  Network: http://${iface.address}:${PORT}`);
      }
    }
  }
});
