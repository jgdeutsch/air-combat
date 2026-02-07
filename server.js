const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game constants
const MAP_W = 4000;
const MAP_H = 3000;
const PLANE_SIZE = 20;
const BULLET_SPEED = 12;
const BULLET_RADIUS = 3;
const BULLET_LIFE = 800; // ms
const MIN_SPEED = 2;
const MAX_SPEED = 6;
const DEFAULT_SPEED = 4;
const TURN_RATE = 0.04;
const THROTTLE_ACCEL = 0.05;
const SHOOT_COOLDOWN = 150; // rapid fire machine gun
const BOMB_COOLDOWN = 3000;
const MAX_HP = 100;
const BULLET_DAMAGE = 8;
const BOMB_DAMAGE = 40;
const BOMB_RADIUS = 80;
const RESPAWN_TIME = 3000;
const POWERUP_INTERVAL = 10000;
const POWERUP_DURATION = 8000;
const MAX_AMMO = 100;
const AMMO_PER_PICKUP = 50;
const CLOUD_COUNT = 20;
const MAX_PLAYERS_PER_ROOM = 8;

// Generate decorative clouds
function generateClouds() {
  const clouds = [];
  for (let i = 0; i < CLOUD_COUNT; i++) {
    clouds.push({
      x: Math.random() * MAP_W,
      y: Math.random() * MAP_H,
      r: 40 + Math.random() * 80,
      id: i
    });
  }
  return clouds;
}

// Game rooms
const rooms = {};

function createRoom(id) {
  return {
    id,
    players: {},
    bullets: [],
    bombs: [],
    explosions: [],
    powerups: [],
    clouds: generateClouds(),
    lastPowerup: Date.now(),
    state: 'playing'
  };
}

function spawnPos() {
  return {
    x: 200 + Math.random() * (MAP_W - 400),
    y: 200 + Math.random() * (MAP_H - 400),
    angle: Math.random() * Math.PI * 2
  };
}

let nextPlayerNum = 0;

function createPlayer(id, name) {
  const pos = spawnPos();
  nextPlayerNum++;
  return {
    id,
    num: nextPlayerNum,
    name: name || `Pilot ${nextPlayerNum}`,
    x: pos.x,
    y: pos.y,
    angle: pos.angle,
    speed: DEFAULT_SPEED,
    hp: MAX_HP,
    alive: true,
    lastShot: 0,
    lastBomb: 0,
    ammo: MAX_AMMO,
    keys: {},
    powerup: null,
    powerupEnd: 0,
    kills: 0,
    deaths: 0,
    respawnAt: 0,
    damaged: false, // trailing smoke when hp < 40
    contrail: [], // trail positions
    shieldHp: 0 // absorbs damage before real HP
  };
}

function respawnPlayer(player) {
  const pos = spawnPos();
  player.x = pos.x;
  player.y = pos.y;
  player.angle = pos.angle;
  player.speed = DEFAULT_SPEED;
  player.hp = MAX_HP;
  player.alive = true;
  player.ammo = MAX_AMMO;
  player.powerup = null;
  player.powerupEnd = 0;
  player.damaged = false;
  player.contrail = [];
  player.respawnAt = 0;
  player.shieldHp = 0;
}

const POWERUP_TYPES = ['ammo', 'repair', 'speed', 'reargun', 'shield'];

function spawnPowerup(room) {
  const x = 100 + Math.random() * (MAP_W - 200);
  const y = 100 + Math.random() * (MAP_H - 200);
  room.powerups.push({
    x, y,
    type: POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)],
    id: Math.random().toString(36).slice(2)
  });
}

function applyDamage(player, amount) {
  if (player.shieldHp > 0) {
    const absorbed = Math.min(player.shieldHp, amount);
    player.shieldHp -= absorbed;
    amount -= absorbed;
  }
  player.hp -= amount;
}

function distSq(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

function updateGame(room) {
  const now = Date.now();
  const players = Object.values(room.players);
  const alivePlayers = players.filter(p => p.alive);

  // Spawn powerups
  if (now - room.lastPowerup > POWERUP_INTERVAL && room.powerups.length < 5) {
    spawnPowerup(room);
    room.lastPowerup = now;
  }

  // Update players
  for (const p of players) {
    // Handle respawn
    if (!p.alive && p.respawnAt > 0 && now >= p.respawnAt) {
      respawnPlayer(p);
      continue;
    }
    if (!p.alive) continue;

    // Expire powerups
    if (p.powerup && now > p.powerupEnd) {
      p.powerup = null;
    }

    // Throttle
    if (p.keys.throttleUp) {
      p.speed = Math.min(MAX_SPEED, p.speed + THROTTLE_ACCEL);
    }
    if (p.keys.throttleDown) {
      p.speed = Math.max(MIN_SPEED, p.speed - THROTTLE_ACCEL);
    }

    // Banking turns
    const effectiveSpeed = p.powerup === 'speed' ? p.speed * 1.5 : p.speed;
    const turnFactor = TURN_RATE * (1 + (MAX_SPEED - p.speed) / MAX_SPEED * 0.5); // slower = tighter turns
    if (p.keys.left) p.angle -= turnFactor;
    if (p.keys.right) p.angle += turnFactor;

    // Always move forward (planes can't stop)
    p.x += Math.cos(p.angle) * effectiveSpeed;
    p.y += Math.sin(p.angle) * effectiveSpeed;

    // Arena wrapping
    if (p.x < 0) p.x += MAP_W;
    if (p.x > MAP_W) p.x -= MAP_W;
    if (p.y < 0) p.y += MAP_H;
    if (p.y > MAP_H) p.y -= MAP_H;

    // Contrail (store last 30 positions)
    p.contrail.push({ x: p.x, y: p.y });
    if (p.contrail.length > 30) p.contrail.shift();

    // Damage state
    p.damaged = p.hp < 40;

    // Machine gun shooting
    if (p.keys.shoot && p.ammo > 0) {
      const cooldown = p.powerup === 'reargun' ? SHOOT_COOLDOWN : SHOOT_COOLDOWN;
      if (now - p.lastShot > cooldown) {
        p.lastShot = now;
        p.ammo--;
        // Forward bullets with slight spread for machine gun feel
        const spread = (Math.random() - 0.5) * 0.08;
        const bx = p.x + Math.cos(p.angle) * (PLANE_SIZE + 5);
        const by = p.y + Math.sin(p.angle) * (PLANE_SIZE + 5);
        room.bullets.push({
          x: bx, y: by,
          vx: Math.cos(p.angle + spread) * BULLET_SPEED + Math.cos(p.angle) * effectiveSpeed * 0.5,
          vy: Math.sin(p.angle + spread) * BULLET_SPEED + Math.sin(p.angle) * effectiveSpeed * 0.5,
          owner: p.id,
          ownerNum: p.num,
          born: now
        });

        // Rear gunner powerup: also shoots backwards
        if (p.powerup === 'reargun') {
          const rearAngle = p.angle + Math.PI;
          room.bullets.push({
            x: p.x + Math.cos(rearAngle) * (PLANE_SIZE + 5),
            y: p.y + Math.sin(rearAngle) * (PLANE_SIZE + 5),
            vx: Math.cos(rearAngle + spread) * BULLET_SPEED * 0.7,
            vy: Math.sin(rearAngle + spread) * BULLET_SPEED * 0.7,
            owner: p.id,
            ownerNum: p.num,
            born: now
          });
        }
      }
    }

    // Bomb drop
    if (p.keys.bomb && now - p.lastBomb > BOMB_COOLDOWN) {
      p.lastBomb = now;
      room.bombs.push({
        x: p.x,
        y: p.y,
        owner: p.id,
        ownerNum: p.num,
        born: now,
        detonateAt: now + 1000 // 1 second fuse
      });
    }

    // Pickup powerups
    for (let i = room.powerups.length - 1; i >= 0; i--) {
      const pu = room.powerups[i];
      if (distSq(p.x, p.y, pu.x, pu.y) < (PLANE_SIZE + 15) * (PLANE_SIZE + 15)) {
        if (pu.type === 'ammo') {
          p.ammo = Math.min(MAX_AMMO, p.ammo + AMMO_PER_PICKUP);
        } else if (pu.type === 'repair') {
          p.hp = Math.min(MAX_HP, p.hp + 40);
        } else if (pu.type === 'shield') {
          p.shieldHp = 50; // absorbs 50 damage before real HP takes hits
        } else {
          p.powerup = pu.type;
          p.powerupEnd = now + POWERUP_DURATION;
        }
        room.powerups.splice(i, 1);
      }
    }
  }

  // Update bullets
  for (let i = room.bullets.length - 1; i >= 0; i--) {
    const b = room.bullets[i];
    b.x += b.vx;
    b.y += b.vy;

    // Bullet lifetime
    if (now - b.born > BULLET_LIFE) {
      room.bullets.splice(i, 1);
      continue;
    }

    // Wrap bullets too
    if (b.x < 0) b.x += MAP_W;
    if (b.x > MAP_W) b.x -= MAP_W;
    if (b.y < 0) b.y += MAP_H;
    if (b.y > MAP_H) b.y -= MAP_H;

    // Player collision
    for (const p of alivePlayers) {
      if (p.id === b.owner) continue;
      if (distSq(p.x, p.y, b.x, b.y) < (PLANE_SIZE + BULLET_RADIUS) * (PLANE_SIZE + BULLET_RADIUS)) {
        applyDamage(p, BULLET_DAMAGE);
        room.explosions.push({ x: b.x, y: b.y, t: now, size: 'small' });
        // Notify the attacker they hit someone
        const attackerSocket = io.sockets.sockets.get(b.owner);
        const attackerPlayer = room.players[b.owner];
        if (attackerSocket) {
          attackerSocket.emit('hit', { victim: p.name, weapon: 'machinegun', killed: p.hp <= 0 });
        }
        // Notify the victim they got hit
        const victimSocket = io.sockets.sockets.get(p.id);
        if (victimSocket && attackerPlayer) {
          victimSocket.emit('gotHit', { attacker: attackerPlayer.name, weapon: 'machinegun', killed: p.hp <= 0 });
        }
        if (p.hp <= 0) {
          killPlayer(room, p, b.owner, now);
        }
        room.bullets.splice(i, 1);
        break;
      }
    }
  }

  // Update bombs
  for (let i = room.bombs.length - 1; i >= 0; i--) {
    const bomb = room.bombs[i];
    if (now >= bomb.detonateAt) {
      // Explode
      room.explosions.push({ x: bomb.x, y: bomb.y, t: now, size: 'bomb' });
      // Damage nearby planes
      for (const p of alivePlayers) {
        if (distSq(p.x, p.y, bomb.x, bomb.y) < BOMB_RADIUS * BOMB_RADIUS) {
          applyDamage(p, BOMB_DAMAGE);
          // Notify the bomber they hit someone
          if (p.id !== bomb.owner) {
            const attackerSocket = io.sockets.sockets.get(bomb.owner);
            const attackerPlayer = room.players[bomb.owner];
            if (attackerSocket) {
              attackerSocket.emit('hit', { victim: p.name, weapon: 'bomb', killed: p.hp <= 0 });
            }
            // Notify the victim they got hit
            const victimSocket = io.sockets.sockets.get(p.id);
            if (victimSocket && attackerPlayer) {
              victimSocket.emit('gotHit', { attacker: attackerPlayer.name, weapon: 'bomb', killed: p.hp <= 0 });
            }
          }
          if (p.hp <= 0) {
            killPlayer(room, p, bomb.owner, now);
          }
        }
      }
      room.bombs.splice(i, 1);
    }
  }

  // Clean old explosions
  room.explosions = room.explosions.filter(e => now - e.t < 600);
}

function killPlayer(room, player, killerId, now) {
  player.alive = false;
  player.hp = 0;
  player.deaths++;
  room.explosions.push({ x: player.x, y: player.y, t: now, size: 'big' });
  const killer = room.players[killerId];
  if (killer && killer.id !== player.id) killer.kills++;
  player.respawnAt = now + RESPAWN_TIME;
}

// Socket handling
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = 'Unknown';

  socket.on('join', (data) => {
    playerName = (data.name || 'Pilot').slice(0, 16);
    const roomId = data.room || 'default';

    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId);
    }

    const room = rooms[roomId];
    const playerCount = Object.keys(room.players).length;

    if (playerCount >= MAX_PLAYERS_PER_ROOM) {
      socket.emit('full', { message: 'Room is full! Try another room name.' });
      return;
    }

    room.players[socket.id] = createPlayer(socket.id, playerName);
    currentRoom = roomId;
    socket.join(roomId);

    socket.emit('joined', {
      playerId: socket.id,
      playerNum: room.players[socket.id].num,
      map: { w: MAP_W, h: MAP_H, clouds: room.clouds }
    });

    // Game is always 'playing' - players can join/leave freely
    io.to(roomId).emit('playerJoined', {
      name: playerName,
      count: Object.keys(room.players).length
    });
  });

  socket.on('input', (data) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const player = rooms[currentRoom].players[socket.id];
    if (!player) return;
    if (data.keys) player.keys = data.keys;
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[socket.id];
    const name = player ? player.name : 'Unknown';
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      delete rooms[currentRoom];
    } else {
      io.to(currentRoom).emit('playerLeft', {
        name,
        count: Object.keys(room.players).length
      });
    }
  });
});

// Game loop at 60fps
setInterval(() => {
  for (const roomId in rooms) {
    const room = rooms[roomId];
    updateGame(room);

    const state = {
      players: Object.values(room.players).map(p => ({
        id: p.id, num: p.num, name: p.name,
        x: p.x, y: p.y, angle: p.angle,
        speed: p.speed, hp: p.hp, alive: p.alive,
        ammo: p.ammo, powerup: p.powerup, shieldHp: p.shieldHp,
        kills: p.kills, deaths: p.deaths,
        damaged: p.damaged,
        contrail: p.contrail.slice(-20) // send last 20 positions
      })),
      bullets: room.bullets.map(b => ({ x: b.x, y: b.y, ownerNum: b.ownerNum })),
      bombs: room.bombs.map(b => ({ x: b.x, y: b.y, age: Date.now() - b.born })),
      explosions: room.explosions.map(e => ({ x: e.x, y: e.y, size: e.size, age: Date.now() - e.t })),
      powerups: room.powerups.map(pu => ({ x: pu.x, y: pu.y, type: pu.type }))
    };

    io.to(roomId).emit('state', state);
  }
}, 1000 / 60);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Air Combat running on http://localhost:${PORT}`);
});
