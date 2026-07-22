const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ========== Sadə AUTH ==========
const users = new Map();
const tokens = new Map();

app.post('/api/register', (req, res) => {
  const { fullname, username, password } = req.body;
  if (!fullname || !username || !password) return res.json({ error: 'All fields required' });
  if (users.has(username)) return res.json({ error: 'Username exists' });
  users.set(username, { fullname, username, password, wins: 0, losses: 0 });
  const token = crypto.randomUUID();
  tokens.set(token, username);
  res.json({ token, username, fullname });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user || user.password !== password) return res.json({ error: 'Invalid credentials' });
  const token = crypto.randomUUID();
  tokens.set(token, username);
  res.json({ token, username, fullname: user.fullname });
});

app.get('/api/verify', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.json({ valid: false });
  res.json({ valid: tokens.has(auth.split(' ')[1]) });
});

// ========== OYUN (server tərəf) ==========
const WIN = 11, GAP = 2, W = 800, H = 500, TICK = 1000/60;
let waiting = null;
const games = new Map();

function newBall() {
  const s = W * 0.0055, a = (Math.random() - 0.5) * 0.8;
  return { x: W/2, y: H/2, r: 10, vx: (Math.random()>0.5?1:-1)*s*Math.cos(a), vy: s*Math.sin(a), speed: s };
}

function moveBall(g) {
  const b = g.ball;
  let rem = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  if (!rem) return;
  const steps = Math.ceil(rem / (b.r * 0.8));
  const sx = b.vx/steps, sy = b.vy/steps;
  for (let i=0; i<steps; i++) {
    b.x += sx; b.y += sy;
    if (b.y - b.r <= 0 || b.y + b.r >= H) { b.vy *= -1; b.y = Math.max(b.r, Math.min(H - b.r, b.y)); }
    const lp = { x:24, y:g.ly, w:10, h:100 }, rp = { x:W-34, y:g.ry, w:10, h:100 };
    if (b.vx < 0 && b.x - b.r <= lp.x + lp.w && b.x + b.r >= lp.x && b.y + b.r > lp.y && b.y - b.r < lp.y + lp.h) {
      b.speed += 0.3; b.vx = Math.abs(b.vx) + 0.3; b.vy = ((b.y - (lp.y+50))/50) * b.speed * 0.8; b.x = lp.x + lp.w + b.r; break;
    }
    if (b.vx > 0 && b.x + b.r >= rp.x && b.x - b.r <= rp.x + rp.w && b.y + b.r > rp.y && b.y - b.r < rp.y + rp.h) {
      b.speed += 0.3; b.vx = -(Math.abs(b.vx) + 0.3); b.vy = ((b.y - (rp.y+50))/50) * b.speed * 0.8; b.x = rp.x - b.r; break;
    }
    if (b.x + b.r < 0) { g.sr++; if (g.sr>=WIN && g.sr-g.sl>=GAP) g.winner='right'; else g.ball=newBall(); update(g); return; }
    if (b.x - b.r > W)  { g.sl++; if (g.sl>=WIN && g.sl-g.sr>=GAP) g.winner='left';  else g.ball=newBall(); update(g); return; }
  }
}

function update(g) { if (g.winner) { clearInterval(g.loop); games.delete(g.id); } }

function create(p1, p2) {
  const g = { id: Date.now().toString(), p: [p1,p2], ball: newBall(), ly: H/2-50, ry: H/2-50, sl:0, sr:0, winner:null, loop:null };
  g.loop = setInterval(() => {
    if (g.winner) return;
    moveBall(g);
    const s = { type:'state', ball:{ x:g.ball.x, y:g.ball.y, vx:g.ball.vx, vy:g.ball.vy }, leftY:g.ly, rightY:g.ry, scores:{ left:g.sl, right:g.sr }, winner:g.winner };
    p1.send(JSON.stringify(s)); p2.send(JSON.stringify(s));
    if (g.winner) { clearInterval(g.loop); games.delete(g.id); }
  }, TICK);
  return g;
}

// Leaderboard
function lb() {
  const list = [...users.values()].sort((a,b)=>b.wins-a.wins).slice(0,10).map(u=>({username:u.username,wins:u.wins,losses:u.losses}));
  wss.clients.forEach(c => c.readyState===WebSocket.OPEN && c.send(JSON.stringify({type:'leaderboard',leaders:list})));
}

// ========== WEBSOCKET ==========
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const token = url.searchParams.get('token');
  const username = token ? tokens.get(token) : null;
  if (!username || !users.has(username)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._username = username;
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  console.log(`${ws._username} bağlandı`);
  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }
    if (data.type === 'join') {
      if (waiting && waiting.readyState === WebSocket.OPEN) {
        const p1 = waiting, p2 = ws;
        const g = create(p1, p2);
        games.set(g.id, g);
        p1.send(JSON.stringify({ type:'opponent', opponent: users.get(p2._username).fullname, side:'left' }));
        p2.send(JSON.stringify({ type:'opponent', opponent: users.get(p1._username).fullname, side:'right' }));
        waiting = null;
      } else waiting = ws;
    } else if (data.type === 'input') {
      for (let [id,g] of games) if (g.p.includes(ws)) { if (data.side==='left') g.ly=data.y; else g.ry=data.y; break; }
    } else if (data.type === 'leave') {
      for (let [id,g] of games) if (g.p.includes(ws)) {
        clearInterval(g.loop); g.winner = g.p.indexOf(ws)===0 ? 'right' : 'left'; g.scores[g.winner]=WIN; update(g);
        const op = g.p.find(p=>p!==ws); if(op&&op.readyState===WebSocket.OPEN) op.send(JSON.stringify({type:'opponent_left'}));
        games.delete(id); break;
      }
    } else if (data.type === 'getLeaderboard') lb();
  });
  ws.on('close', () => {
    if (waiting === ws) waiting = null;
    for (let [id,g] of games) if (g.p.includes(ws)) {
      clearInterval(g.loop); const op = g.p.find(p=>p!==ws); if(op) op.send(JSON.stringify({type:'opponent_left'}));
      games.delete(id); break;
    }
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server ${PORT}`));
