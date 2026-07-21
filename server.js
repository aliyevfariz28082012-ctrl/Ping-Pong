const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Oyun sabitləri
const WIN_SCORE = 11;
const DEUCE_GAP = 2;
const GAME_WIDTH = 800;
const GAME_HEIGHT = 500;
const TICK_RATE = 1000 / 60; // 60 FPS

let players = new Map(); // ws -> playerData
let leaderboard = [];
let waitingPlayer = null;
let games = new Map(); // gameId -> gameData

// Liderboard yeniləmə
function broadcastLeaderboard() {
    const leaders = leaderboard.sort((a, b) => b.wins - a.wins).slice(0, 10);
    const msg = JSON.stringify({ type: 'leaderboard', leaders });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

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

    // Oyun dövrü (60 FPS)
    game.interval = setInterval(() => {
        if (game.winner) {
            clearInterval(game.interval);
            games.delete(game.id);
            return;
        }

        const ball = game.ball;
        ball.x += ball.vx;
        ball.y += ball.vy;

        // divar toqquşması
        if (ball.y - ball.r <= 0 || ball.y + ball.r >= GAME_HEIGHT) {
            ball.vy *= -1;
        }

        // çubuq toqquşması (sadələşdirilmiş)
        const leftPaddle = { x: 24, y: game.leftY, w: 10, h: 100 };
        const rightPaddle = { x: GAME_WIDTH - 34, y: game.rightY, w: 10, h: 100 };

        const hitPaddle = (paddle) => {
            return ball.x + ball.r > paddle.x && ball.x - ball.r < paddle.x + paddle.w &&
                   ball.y + ball.r > paddle.y && ball.y - ball.r < paddle.y + paddle.h;
        };

        if (ball.vx < 0 && hitPaddle(leftPaddle)) {
            const hitPos = (ball.y - (leftPaddle.y + leftPaddle.h / 2)) / (leftPaddle.h / 2);
            ball.vx = Math.abs(ball.vx);
            ball.vy = hitPos * ball.speed * 0.8;
            ball.x = leftPaddle.x + leftPaddle.w + ball.r;
        } else if (ball.vx > 0 && hitPaddle(rightPaddle)) {
            const hitPos = (ball.y - (rightPaddle.y + rightPaddle.h / 2)) / (rightPaddle.h / 2);
            ball.vx = -Math.abs(ball.vx);
            ball.vy = hitPos * ball.speed * 0.8;
            ball.x = rightPaddle.x - ball.r;
        }

        // qol
        if (ball.x + ball.r < 0) {
            game.scores.right++;
            if (checkWin(game)) {
                game.winner = 'right';
                updateLeaderboardForGame(game);
            } else {
                game.ball = resetBall();
            }
        } else if (ball.x - ball.r > GAME_WIDTH) {
            game.scores.left++;
            if (checkWin(game)) {
                game.winner = 'left';
                updateLeaderboardForGame(game);
            } else {
                game.ball = resetBall();
            }
        }

        // oyunçuya vəziyyət göndər
        const stateMsg = JSON.stringify({
            type: 'state',
            ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy },
            leftY: game.leftY,
            rightY: game.rightY,
            scores: game.scores,
            winner: game.winner
        });
        p1.send(stateMsg);
        p2.send(stateMsg);

        if (game.winner) {
            clearInterval(game.interval);
            games.delete(game.id);
        }
    }, TICK_RATE);

    return game;
}

function checkWin(game) {
    return (game.scores.left >= WIN_SCORE && game.scores.left - game.scores.right >= DEUCE_GAP) ||
           (game.scores.right >= WIN_SCORE && game.scores.right - game.scores.left >= DEUCE_GAP);
}

function updateLeaderboardForGame(game) {
    const p1 = game.players[0];
    const p2 = game.players[1];
    const p1Data = players.get(p1);
    const p2Data = players.get(p2);
    if (!p1Data || !p2Data) return;

    const p1Leader = leaderboard.find(l => l.name === p1Data.name);
    const p2Leader = leaderboard.find(l => l.name === p2Data.name);

    if (game.winner === 'left') {
        if (p1Leader) p1Leader.wins++;
        if (p2Leader) p2Leader.losses++;
    } else {
        if (p2Leader) p2Leader.wins++;
        if (p1Leader) p1Leader.losses++;
    }
    broadcastLeaderboard();
}

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.type === 'register') {
            players.set(ws, { name: data.name });
            const exist = leaderboard.find(l => l.name === data.name);
            if (!exist) leaderboard.push({ name: data.name, wins: 0, losses: 0 });
            broadcastLeaderboard();
        }
        else if (data.type === 'join') {
            if (waitingPlayer && waitingPlayer !== ws) {
                const p1 = waitingPlayer;
                const p2 = ws;
                const game = createGame(p1, p2);
                games.set(game.id, game);

                p1.send(JSON.stringify({ type: 'opponent', opponent: players.get(p2).name, side: 'left' }));
                p2.send(JSON.stringify({ type: 'opponent', opponent: players.get(p1).name, side: 'right' }));
                waitingPlayer = null;
            } else {
                waitingPlayer = ws;
            }
        }
        else if (data.type === 'input') {
            const playerData = players.get(ws);
            if (!playerData) return;
            // Oyunu tap (bu oyunçu hansı oyundadır)
            for (let [id, game] of games) {
                if (game.players.includes(ws)) {
                    if (data.side === 'left') game.leftY = data.y;
                    else game.rightY = data.y;
                    break;
                }
            }
        }
        else if (data.type === 'getLeaderboard') {
            broadcastLeaderboard();
        }
    });

    ws.on('close', () => {
        if (waitingPlayer === ws) waitingPlayer = null;
        // Əgər oyundadırsa, rəqibə xəbər ver
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
        players.delete(ws);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
