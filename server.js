const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============ AUTH SYSTEM ============
const users = new Map();
const tokens = new Map();

app.post('/api/register', (req, res) => {
    const { fullname, username, password } = req.body;
    if (!fullname || !username || !password) {
        return res.json({ error: 'All fields are required' });
    }
    if (users.has(username)) {
        return res.json({ error: 'Username already exists' });
    }
    users.set(username, { fullname, username, password, wins: 0, losses: 0 });
    const token = crypto.randomUUID();
    tokens.set(token, username);
    res.json({ token, username, fullname });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    if (!user || user.password !== password) {
        return res.json({ error: 'Invalid username or password' });
    }
    const token = crypto.randomUUID();
    tokens.set(token, username);
    res.json({ token, username, fullname: user.fullname });
});

app.get('/api/verify', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.json({ valid: false });
    }
    const token = auth.split(' ')[1];
    res.json({ valid: tokens.has(token) });
});

// ============ GAME SYSTEM ============
const WIN_SCORE = 11;
const DEUCE_GAP = 2;
const GAME_WIDTH = 800;
const GAME_HEIGHT = 500;
const TICK_RATE = 1000 / 60;

let waitingPlayer = null;
let games = new Map();

function resetBall() {
    const speed = GAME_WIDTH * 0.0055;
    const angle = (Math.random() - 0.5) * 0.8;
    return {
        x: GAME_WIDTH / 2,
        y: GAME_HEIGHT / 2,
        vx: (Math.random() > 0.5 ? 1 : -1) * speed * Math.cos(angle),
        vy: speed * Math.sin(angle),
        speed: speed,
        r: 10
    };
}

function moveBall(game) {
    const ball = game.ball;
    const maxStep = ball.r * 0.8;
    let remaining = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
    if (remaining === 0) return;

    const steps = Math.ceil(remaining / maxStep);
    const stepX = ball.vx / steps;
    const stepY = ball.vy / steps;

    for (let i = 0; i < steps; i++) {
        ball.x += stepX;
        ball.y += stepY;

        if (ball.y - ball.r <= 0 || ball.y + ball.r >= GAME_HEIGHT) {
            ball.vy *= -1;
            ball.y = Math.max(ball.r, Math.min(GAME_HEIGHT - ball.r, ball.y));
        }

        const lp = { x: 24, y: game.leftY, w: 10, h: 100 };
        const rp = { x: GAME_WIDTH - 34, y: game.rightY, w: 10, h: 100 };

        const paddleHit = (paddle, side) => {
            if (side === 'left' && ball.vx < 0) {
                return ball.x - ball.r <= paddle.x + paddle.w &&
                    ball.x + ball.r >= paddle.x &&
                    ball.y + ball.r > paddle.y &&
                    ball.y - ball.r < paddle.y + paddle.h;
            } else if (side === 'right' && ball.vx > 0) {
                return ball.x + ball.r >= paddle.x &&
                    ball.x - ball.r <= paddle.x + paddle.w &&
                    ball.y + ball.r > paddle.y &&
                    ball.y - ball.r < paddle.y + paddle.h;
            }
            return false;
        };

        if (paddleHit(lp, 'left')) {
            const hitPos = (ball.y - (lp.y + lp.h / 2)) / (lp.h / 2);
            ball.speed += 0.3;
            ball.vx = Math.abs(ball.vx) + 0.3;
            ball.vy = hitPos * ball.speed * 0.8;
            ball.x = lp.x + lp.w + ball.r;
            break;
        }

        if (paddleHit(rp, 'right')) {
            const hitPos = (ball.y - (rp.y + rp.h / 2)) / (rp.h / 2);
            ball.speed += 0.3;
            ball.vx = -(Math.abs(ball.vx) + 0.3);
            ball.vy = hitPos * ball.speed * 0.8;
            ball.x = rp.x - ball.r;
            break;
        }

        if (ball.x + ball.r < 0) {
            game.scores.right++;
            if (game.scores.right >= WIN_SCORE && game.scores.right - game.scores.left >= DEUCE_GAP) {
                game.winner = 'right';
                updateStats(game);
            } else {
                game.ball = resetBall();
            }
            return;
        }
        if (ball.x - ball.r > GAME_WIDTH) {
            game.scores.left++;
            if (game.scores.left >= WIN_SCORE && game.scores.left - game.scores.right >= DEUCE_GAP) {
                game.winner = 'left';
                updateStats(game);
            } else {
                game.ball = resetBall();
            }
            return;
        }
    }
}

function createGame(p1, p2) {
    const game = {
        id: Date.now().toString(),
        players: [p1, p2],
        ball: resetBall(),
        leftY: GAME_HEIGHT / 2 - 50,
        rightY: GAME_HEIGHT / 2 - 50,
        scores: { left: 0, right: 0 },
        winner: null,
        interval: null
    };

    game.interval = setInterval(() => {
        if (game.winner) {
            clearInterval(game.interval);
            games.delete(game.id);
            return;
        }

        moveBall(game);

        const state = {
            type: 'state',
            ball: { x: game.ball.x, y: game.ball.y, vx: game.ball.vx, vy: game.ball.vy },
            leftY: game.leftY,
            rightY: game.rightY,
            scores: game.scores,
            winner: game.winner
        };
        p1.send(JSON.stringify(state));
        p2.send(JSON.stringify(state));

        if (game.winner) {
            clearInterval(game.interval);
            games.delete(game.id);
        }
    }, TICK_RATE);
    return game;
}

function updateStats(game) {
    const [p1, p2] = game.players;
    const u1 = p1._username;
    const u2 = p2._username;
    if (u1 && u2 && users.has(u1) && users.has(u2)) {
        if (game.winner === 'left') {
            users.get(u1).wins++;
            users.get(u2).losses++;
        } else {
            users.get(u2).wins++;
            users.get(u1).losses++;
        }
    }
    broadcastLeaderboard();
}

function broadcastLeaderboard() {
    const leaders = [...users.values()]
        .sort((a, b) => b.wins - a.wins)
        .slice(0, 10)
        .map(u => ({ username: u.username, fullname: u.fullname, wins: u.wins, losses: u.losses }));
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'leaderboard', leaders }));
    });
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const username = tokens.get(token);
    if (!username || !users.has(username)) {
        ws.close(4001, 'Unauthorized');
        return;
    }
    ws._username = username;

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'join') {
            // DÜZƏLİŞ BURADADIR:
            // Əgər gözləyən varsa və bağlantısı açıqdırsa, oyunu başlat.
            if (waitingPlayer && waitingPlayer.readyState === WebSocket.OPEN) {
                const p1 = waitingPlayer;
                const p2 = ws;
                const game = createGame(p1, p2);
                games.set(game.id, game);
                p1.send(JSON.stringify({ type: 'opponent', opponent: users.get(p2._username).fullname, side: 'left' }));
                p2.send(JSON.stringify({ type: 'opponent', opponent: users.get(p1._username).fullname, side: 'right' }));
                waitingPlayer = null;
            } else {
                // Gözləyən yoxdursa (və ya bağlantısı bağlıdırsa), özünü gözləməyə qoy.
                waitingPlayer = ws;
            }
        } else if (data.type === 'input') {
            for (let [id, game] of games) {
                if (game.players.includes(ws)) {
                    if (data.side === 'left') game.leftY = data.y;
                    else game.rightY = data.y;
                    break;
                }
            }
        } else if (data.type === 'leave') {
            for (let [id, game] of games) {
                if (game.players.includes(ws)) {
                    clearInterval(game.interval);
                    const leaverSide = game.players.indexOf(ws);
                    game.winner = leaverSide === 0 ? 'right' : 'left';
                    game.scores[game.winner] = WIN_SCORE;
                    updateStats(game);
                    const opponent = game.players.find(p => p !== ws);
                    if (opponent && opponent.readyState === WebSocket.OPEN) {
                        opponent.send(JSON.stringify({
                            type: 'state',
                            ball: game.ball,
                            leftY: game.leftY,
                            rightY: game.rightY,
                            scores: game.scores,
                            winner: game.winner
                        }));
                    }
                    games.delete(id);
                    break;
                }
            }
        } else if (data.type === 'getLeaderboard') {
            broadcastLeaderboard();
        }
    });

    ws.on('close', () => {
        if (waitingPlayer === ws) waitingPlayer = null;
        for (let [id, game] of games) {
            if (game.players.includes(ws)) {
                clearInterval(game.interval);
                const opponent = game.players.find(p => p !== ws);
                if (opponent && opponent.readyState === WebSocket.OPEN) {
                    opponent.send(JSON.stringify({ type: 'opponent_left' }));
                }
                games.delete(id);
                break;
            }
        }
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
