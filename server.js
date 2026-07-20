const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// index.html-i təqdim et
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Oyun dəyişənləri
const WIN_SCORE = 11;
const DEUCE_GAP = 2;

let players = {};
let leaderboard = [];
let waitingPlayer = null;

function broadcastLeaderboard() {
    const leaders = leaderboard.sort((a, b) => b.wins - a.wins).slice(0, 10);
    const msg = JSON.stringify({ type: 'leaderboard', leaders });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

function resetBall(width, height) {
    const speed = width * 0.0055;
    const angle = (Math.random() - 0.5) * 0.8;
    return {
        x: width / 2, y: height / 2, r: 10,
        vx: (Math.random() > 0.5 ? 1 : -1) * speed * Math.cos(angle),
        vy: speed * Math.sin(angle)
    };
}

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.type === 'register') {
            players[ws] = { name: data.name };
            const exist = leaderboard.find(p => p.name === data.name);
            if (!exist) leaderboard.push({ name: data.name, wins: 0, losses: 0 });
            broadcastLeaderboard();
        }
        else if (data.type === 'join') {
            if (waitingPlayer && waitingPlayer !== ws) {
                const p1 = waitingPlayer;
                const p2 = ws;
                players[p1].opponent = p2;
                players[p2].opponent = p1;
                players[p1].side = 'left';
                players[p2].side = 'right';
                players[p1].game = {
                    ball: resetBall(800, 500),
                    leftY: 200, rightY: 200,
                    scores: { left: 0, right: 0 },
                    winner: null
                };
                players[p2].game = players[p1].game;
                p1.send(JSON.stringify({ type: 'opponent', opponent: players[p2].name, side: 'left' }));
                p2.send(JSON.stringify({ type: 'opponent', opponent: players[p1].name, side: 'right' }));
                waitingPlayer = null;
            } else {
                waitingPlayer = ws;
            }
        }
        else if (data.type === 'input') {
            const player = players[ws];
            if (!player || !player.game) return;
            const game = player.game;
            if (data.side === 'left') game.leftY = data.y;
            else game.rightY = data.y;
            updateGame(game, 800, 500);
            const state = {
                type: 'state',
                ball: game.ball,
                leftY: game.leftY,
                rightY: game.rightY,
                scores: game.scores,
                winner: game.winner
            };
            if (player.opponent) {
                ws.send(JSON.stringify(state));
                player.opponent.send(JSON.stringify(state));
            }
            if (game.winner) {
                const leftPlayer = [...wss.clients].find(c => players[c] && players[c].side === 'left');
                const rightPlayer = [...wss.clients].find(c => players[c] && players[c].side === 'right');
                if (leftPlayer && rightPlayer) {
                    const lName = players[leftPlayer].name;
                    const rName = players[rightPlayer].name;
                    const lLead = leaderboard.find(p => p.name === lName);
                    const rLead = leaderboard.find(p => p.name === rName);
                    if (game.winner === 'left') {
                        if (lLead) lLead.wins++;
                        if (rLead) rLead.losses++;
                    } else {
                        if (rLead) rLead.wins++;
                        if (lLead) lLead.losses++;
                    }
                }
                broadcastLeaderboard();
                delete player.game;
                if (player.opponent) delete players[player.opponent].game;
            }
        }
        else if (data.type === 'getLeaderboard') {
            broadcastLeaderboard();
        }
    });

    ws.on('close', () => {
        if (waitingPlayer === ws) waitingPlayer = null;
        if (players[ws] && players[ws].opponent) {
            players[ws].opponent.send(JSON.stringify({ type: 'opponent_left' }));
        }
        delete players[ws];
    });
});

function updateGame(game, width, height) {
    const ball = game.ball;
    ball.x += ball.vx;
    ball.y += ball.vy;
    if (ball.y - ball.r <= 0 || ball.y + ball.r >= height) ball.vy *= -1;

    const leftPaddle = { x: 20, y: game.leftY, w: 10, h: 100 };
    const rightPaddle = { x: width - 30, y: game.rightY, w: 10, h: 100 };

    const hit = (p) => ball.x + ball.r > p.x && ball.x - ball.r < p.x + p.w &&
        ball.y + ball.r > p.y && ball.y - ball.r < p.y + p.h;
    if (ball.vx < 0 && hit(leftPaddle)) {
        const hitPos = (ball.y - (leftPaddle.y + leftPaddle.h / 2)) / (leftPaddle.h / 2);
        ball.vx = Math.abs(ball.vx);
        ball.vy = hitPos * ball.speed * 0.8;
        ball.x = leftPaddle.x + leftPaddle.w + ball.r;
    } else if (ball.vx > 0 && hit(rightPaddle)) {
        const hitPos = (ball.y - (rightPaddle.y + rightPaddle.h / 2)) / (rightPaddle.h / 2);
        ball.vx = -Math.abs(ball.vx);
        ball.vy = hitPos * ball.speed * 0.8;
        ball.x = rightPaddle.x - ball.r;
    }

    if (ball.x + ball.r < 0) {
        game.scores.right++;
        checkWin(game);
        game.ball = resetBall(width, height);
    } else if (ball.x - ball.r > width) {
        game.scores.left++;
        checkWin(game);
        game.ball = resetBall(width, height);
    }
}

function checkWin(game) {
    if (game.scores.left >= WIN_SCORE && game.scores.left - game.scores.right >= DEUCE_GAP)
        game.winner = 'left';
    else if (game.scores.right >= WIN_SCORE && game.scores.right - game.scores.left >= DEUCE_GAP)
        game.winner = 'right';
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));