const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

const dataDir = path.join(__dirname, "data");
require("fs").mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "neon-arena.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  auth_token TEXT UNIQUE,
  best_score INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
`);

// Upgrade databases created by older versions of Neon Arena.
try { db.prepare("ALTER TABLE users ADD COLUMN auth_token TEXT").run(); } catch (e) {
  if (!String(e.message).includes("duplicate column name")) throw e;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sessions = new Map(); // socket.id -> {id, username}
const online = new Map();   // user id -> socket id
const rooms = new Map();

const COLORS = ["#67e8f9","#a78bfa","#fb7185","#facc15","#4ade80","#fb923c","#f472b6","#38bdf8"];

function cleanName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
}
function validName(name) {
  return /^[A-Za-z0-9_ -]{3,18}$/.test(name);
}
function now() { return Date.now(); }
function userById(id) {
  return db.prepare("SELECT id, username, best_score, wins FROM users WHERE id=?").get(id);
}
function createAuthToken() { return crypto.randomBytes(32).toString("hex"); }
function usernameExists(name) {
  return !!db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(name);
}
function getFriends(id) {
  return db.prepare(`
    SELECT u.id, u.username, u.best_score, u.wins
    FROM friendships f JOIN users u ON u.id=f.friend_id
    WHERE f.user_id=? ORDER BY u.username
  `).all(id);
}
function getRequests(id) {
  return db.prepare(`
    SELECT r.id, r.from_id, u.username, u.best_score
    FROM friend_requests r JOIN users u ON u.id=r.from_id
    WHERE r.to_id=? AND r.status='pending'
    ORDER BY r.created_at DESC
  `).all(id);
}
function publicUser(id) {
  const u = userById(id);
  return u ? { id:u.id, username:u.username, bestScore:u.best_score, wins:u.wins } : null;
}
function broadcastFriends(id) {
  const sid = online.get(id);
  if (!sid) return;
  io.to(sid).emit("friends:data", {
    friends: getFriends(id).map(x=>({id:x.id, username:x.username, bestScore:x.best_score, wins:x.wins})),
    requests: getRequests(id).map(x=>({id:x.id, fromId:x.from_id, username:x.username, bestScore:x.best_score}))
  });
}
function emitRoom(room) {
  const list = [...room.players.values()].map(p => ({
    id:p.id, username:p.username, color:p.color, ready:p.ready, score:p.score
  }));
  io.to(room.id).emit("room:update", {
    id:room.id, hostId:room.hostId, state:room.state, players:list,
    maxPlayers:room.maxPlayers, matchEndsAt:room.matchEndsAt || null
  });
}
function createRoom(host) {
  const id = crypto.randomBytes(3).toString("hex").toUpperCase();
  const room = {
    id, hostId:host.id, maxPlayers:8, state:"lobby",
    players:new Map(), bullets:new Map(), matchEndsAt:null,
    lastTick:now(), createdAt:now()
  };
  rooms.set(id, room);
  addPlayer(room, host);
  return room;
}
function addPlayer(room, user) {
  room.players.set(user.id, {
    id:user.id, username:user.username, color:COLORS[room.players.size % COLORS.length],
    x:180 + Math.random()*740, y:120 + Math.random()*400,
    hp:100, score:0, kills:0, deaths:0, ready:true,
    vx:0, vy:0, dash:0, lastShot:0
  });
}
function roomForUser(id) {
  for (const room of rooms.values()) if (room.players.has(id)) return room;
  return null;
}
function removeFromRoom(id) {
  const room = roomForUser(id);
  if (!room) return null;
  room.players.delete(id);
  if (room.hostId === id) {
    const next = room.players.keys().next().value;
    room.hostId = next || null;
  }
  if (!room.players.size) rooms.delete(room.id);
  else emitRoom(room);
  return room;
}
function resetMatch(room) {
  room.state = "playing";
  room.matchEndsAt = now() + 120000;
  room.bullets.clear();
  let i=0;
  for (const p of room.players.values()) {
    p.x = 160 + Math.random()*800;
    p.y = 120 + Math.random()*460;
    p.hp=100; p.score=0; p.kills=0; p.deaths=0; p.dash=0;
    p.color=COLORS[i++ % COLORS.length];
  }
}
function endMatch(room) {
  if (!rooms.has(room.id) || room.state !== "playing") return;
  room.state = "results";
  room.matchEndsAt = null;
  const results = [...room.players.values()].sort((a,b)=>b.score-a.score).map((p,i)=>({
    rank:i+1, id:p.id, username:p.username, score:p.score, kills:p.kills, deaths:p.deaths
  }));
  const update = db.prepare("UPDATE users SET best_score=MAX(best_score,?), wins=wins+? WHERE id=?");
  const tx = db.transaction(() => results.forEach((r,i)=>update.run(r.score, i===0 ? 1 : 0, r.id)));
  tx();
  io.to(room.id).emit("match:results", results);
  emitRoom(room);
  setTimeout(() => {
    if (rooms.get(room.id) === room) {
      room.state = "lobby";
      room.bullets.clear();
      for (const p of room.players.values()) { p.score=0; p.hp=100; }
      emitRoom(room);
    }
  }, 12000);
}

app.get("/api/leaderboard", (req,res)=>{
  const rows = db.prepare("SELECT username, best_score, wins FROM users ORDER BY best_score DESC, wins DESC LIMIT 20").all();
  res.json(rows.map((r,i)=>({rank:i+1, username:r.username, score:r.best_score, wins:r.wins})));
});

io.on("connection", socket => {
  socket.on("profile:login", ({username, userId, authToken}) => {
    const name = cleanName(username);
    if (!validName(name)) return socket.emit("profile:error", "Username must be 3–18 characters and use letters, numbers, spaces, _ or -.");

    let u = null;
    if (userId && authToken) {
      u = db.prepare("SELECT * FROM users WHERE id=? AND auth_token=?").get(String(userId), String(authToken));
      if (!u) return socket.emit("profile:error", "This saved login is no longer valid. Please choose a new username.");
      if (u.username.toLowerCase() !== name.toLowerCase()) {
        return socket.emit("profile:error", "The saved account does not match this username.");
      }
    } else {
      // A username is an account name, not a guest nickname. Existing names
      // cannot be claimed by another browser.
      if (usernameExists(name)) {
        return socket.emit("profile:error", "That username is already taken. Use your saved account or choose another username.");
      }
      const id = crypto.randomUUID();
      const token = createAuthToken();
      try {
        db.prepare("INSERT INTO users(id,username,auth_token,created_at) VALUES(?,?,?,?)").run(id,name,token,now());
        u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
      } catch {
        return socket.emit("profile:error", "That username was just taken. Please choose another one.");
      }
    }

    // Prevent two different browser sessions from controlling the same account.
    const existingSocket = online.get(u.id);
    if (existingSocket && existingSocket !== socket.id) {
      return socket.emit("profile:error", "This username is already online on another device or browser.");
    }

    sessions.set(socket.id,{id:u.id,username:u.username});
    online.set(u.id,socket.id);
    socket.emit("profile:ok", {...publicUser(u.id), authToken:u.auth_token});
    socket.emit("friends:data", {
      friends:getFriends(u.id).map(x=>({id:x.id,username:x.username,bestScore:x.best_score,wins:x.wins})),
      requests:getRequests(u.id).map(x=>({id:x.id,fromId:x.from_id,username:x.username,bestScore:x.best_score}))
    });
    const room=roomForUser(u.id);
    if (room) { socket.join(room.id); emitRoom(room); }
  });

  socket.on("friends:request", ({username})=>{
    const me=sessions.get(socket.id); if(!me) return;
    const targetName=cleanName(username);
    const target=db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(targetName);
    if(!target) return socket.emit("toast","Player not found.");
    if(target.id===me.id) return socket.emit("toast","You cannot add yourself.");
    const existing=db.prepare("SELECT 1 FROM friendships WHERE user_id=? AND friend_id=?").get(me.id,target.id);
    if(existing) return socket.emit("toast","You are already friends.");
    const pending=db.prepare("SELECT 1 FROM friend_requests WHERE from_id=? AND to_id=? AND status='pending'").get(me.id,target.id);
    if(pending) return socket.emit("toast","Request already sent.");
    db.prepare("INSERT INTO friend_requests(id,from_id,to_id,status,created_at) VALUES(?,?,?,?,?)")
      .run(crypto.randomUUID(),me.id,target.id,"pending",now());
    broadcastFriends(target.id); socket.emit("toast","Friend request sent.");
  });

  socket.on("friends:respond", ({requestId,accept})=>{
    const me=sessions.get(socket.id); if(!me) return;
    const r=db.prepare("SELECT * FROM friend_requests WHERE id=? AND to_id=? AND status='pending'").get(requestId,me.id);
    if(!r) return;
    if(accept) {
      const tx=db.transaction(()=>{
        db.prepare("UPDATE friend_requests SET status='accepted' WHERE id=?").run(requestId);
        db.prepare("INSERT OR IGNORE INTO friendships(user_id,friend_id,created_at) VALUES(?,?,?)").run(me.id,r.from_id,now());
        db.prepare("INSERT OR IGNORE INTO friendships(user_id,friend_id,created_at) VALUES(?,?,?)").run(r.from_id,me.id,now());
      }); tx();
      broadcastFriends(r.from_id);
    } else db.prepare("UPDATE friend_requests SET status='declined' WHERE id=?").run(requestId);
    broadcastFriends(me.id);
  });

  socket.on("friends:remove", ({friendId})=>{
    const me=sessions.get(socket.id); if(!me) return;
    db.prepare("DELETE FROM friendships WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)")
      .run(me.id,friendId,friendId,me.id);
    broadcastFriends(me.id); broadcastFriends(friendId);
  });

  socket.on("room:create",()=>{
    const me=sessions.get(socket.id); if(!me) return;
    removeFromRoom(me.id);
    const room=createRoom(me);
    socket.join(room.id);
    emitRoom(room);
  });
  socket.on("room:join",({code})=>{
    const me=sessions.get(socket.id); if(!me) return;
    const id=String(code||"").trim().toUpperCase();
    const room=rooms.get(id);
    if(!room) return socket.emit("toast","Room not found.");
    if(room.state!=="lobby") return socket.emit("toast","That match is already running.");
    if(room.players.size>=room.maxPlayers) return socket.emit("toast","Room is full.");
    removeFromRoom(me.id);
    addPlayer(room,me); socket.join(room.id); emitRoom(room);
  });
  socket.on("room:leave",()=>{
    const me=sessions.get(socket.id); if(!me) return;
    const r=removeFromRoom(me.id); if(r) socket.leave(r.id);
  });
  socket.on("room:start",()=>{
    const me=sessions.get(socket.id); if(!me) return;
    const room=roomForUser(me.id);
    if(!room || room.hostId!==me.id || room.state!=="lobby") return;
    if(room.players.size<1) return;
    resetMatch(room); emitRoom(room);
  });
  socket.on("room:invite",({friendId})=>{
    const me=sessions.get(socket.id); if(!me) return;
    const room=roomForUser(me.id); if(!room) return;
    const sid=online.get(friendId);
    if(!sid) return socket.emit("toast","Your friend is offline.");
    io.to(sid).emit("room:invite", {code:room.id, from:me.username});
    socket.emit("toast","Invite sent.");
  });
  socket.on("chat:send",({scope,message})=>{
    const me=sessions.get(socket.id); if(!me) return;
    const msg=String(message||"").trim().slice(0,300); if(!msg) return;
    if(scope==="room") {
      const room=roomForUser(me.id); if(!room) return;
      io.to(room.id).emit("chat:message",{scope,username:me.username,message:msg,at:now()});
    } else {
      io.emit("chat:message",{scope:"global",username:me.username,message:msg,at:now()});
    }
  });

  socket.on("input", data=>{
    const me=sessions.get(socket.id); if(!me) return;
    const room=roomForUser(me.id); if(!room || room.state!=="playing") return;
    const p=room.players.get(me.id); if(!p) return;
    p.input={
      up:!!data.up,down:!!data.down,left:!!data.left,right:!!data.right,
      angle:Number(data.angle)||0,shoot:!!data.shoot,dash:!!data.dash
    };
  });

  socket.on("disconnect",()=>{
    const me=sessions.get(socket.id);
    if(me) {
      const room=removeFromRoom(me.id);
      online.delete(me.id);
      if(room && room.state==="playing" && room.players.size<1) rooms.delete(room.id);
    }
    sessions.delete(socket.id);
  });
});

const TICK=1000/30;
setInterval(()=>{
  const t=now();
  for(const room of rooms.values()){
    if(room.state!=="playing") continue;
    const dt=Math.min((t-room.lastTick)/1000,0.05); room.lastTick=t;
    if(t>=room.matchEndsAt){ endMatch(room); continue; }

    for(const p of room.players.values()){
      const i=p.input||{};
      let dx=(i.right?1:0)-(i.left?1:0), dy=(i.down?1:0)-(i.up?1:0);
      const len=Math.hypot(dx,dy)||1;
      let speed=260;
      if(i.dash && p.dash<=0 && (dx||dy)){ speed=650; p.dash=0.9; }
      p.dash=Math.max(0,p.dash-dt);
      p.x=Math.max(35,Math.min(1165,p.x+(dx/len)*speed*dt));
      p.y=Math.max(35,Math.min(645,p.y+(dy/len)*speed*dt));
      if(i.shoot && t-p.lastShot>180){
        p.lastShot=t;
        const bid=crypto.randomUUID();
        room.bullets.set(bid,{id:bid,owner:p.id,x:p.x,y:p.y,
          vx:Math.cos(i.angle)*780,vy:Math.sin(i.angle)*780,life:0.9});
      }
    }

    for(const [id,b] of room.bullets){
      b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;
      if(b.life<=0||b.x<0||b.x>1200||b.y<0||b.y>680){room.bullets.delete(id);continue;}
      let hit=false;
      for(const p of room.players.values()){
        if(p.id===b.owner||p.hp<=0) continue;
        if(Math.hypot(p.x-b.x,p.y-b.y)<22){
          p.hp-=34; hit=true;
          const owner=room.players.get(b.owner);
          if(owner) owner.score+=10;
          if(p.hp<=0){
            p.deaths++; if(owner){owner.kills++;owner.score+=100;}
            p.hp=100;p.x=100+Math.random()*1000;p.y=70+Math.random()*570;
            if(owner) io.to(room.id).emit("game:feed",{text:`${owner.username} eliminated ${p.username}`});
          }
          break;
        }
      }
      if(hit) room.bullets.delete(id);
    }

    const state={
      now:t,endsAt:room.matchEndsAt,
      players:[...room.players.values()].map(p=>({
        id:p.id,username:p.username,color:p.color,x:p.x,y:p.y,hp:p.hp,score:p.score,kills:p.kills,deaths:p.deaths,dash:p.dash
      })),
      bullets:[...room.bullets.values()].map(b=>({x:b.x,y:b.y}))
    };
    io.to(room.id).emit("game:state",state);
  }
},TICK);

server.listen(PORT,()=>console.log(`Neon Arena running on port ${PORT}`));
