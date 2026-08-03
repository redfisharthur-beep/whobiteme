const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};

function createDeck() {
    let deck = [];
    const templates = [
        { name: '虎', points: 8, count: 5, emoji: '🐅' },
        { name: '熊', points: 7, count: 5, emoji: '🐻' },
        { name: '獅', points: 6, count: 5, emoji: '🦁', isLion: true },
        { name: '豹', points: 5, count: 5, emoji: '🐆' },
        { name: '狼', points: 4, count: 5, emoji: '🐺' },
        { name: '狐狸', points: 3, count: 5, emoji: '🦊' },
        { name: '蛇', points: 2, count: 5, emoji: '🐍' },
        { name: '兔', points: 1, count: 5, emoji: '🐰', isRabbit: true },
        { name: '細菌', points: 999, count: 1, emoji: '🦠', isBacteria: true },
        { name: '獵人', points: 9, count: 1, emoji: '🏹', isHunter: true }
    ];

    templates.forEach(t => {
        for (let i = 0; i < t.count; i++) {
            deck.push({ ...t, cardId: Math.random().toString(36).substring(2, 9) });
        }
    });

    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getClientFilteredPlayers(room, viewerId) {
    return room.players.map(p => {
        const isSelf = (p.id === viewerId);
        
        const foxExpiry = room.foxVisionExpiry && room.foxVisionExpiry[viewerId] && room.foxVisionExpiry[viewerId][p.id];
        const hasFoxVision = foxExpiry && foxExpiry > 0;

        const knowsCard = isSelf || hasFoxVision || (p.knownCards && p.knownCards[viewerId]);
        return {
            id: p.id,
            name: p.name,
            score: p.score,
            card: knowsCard ? p.card : null,
            foxVisionTurnsLeft: hasFoxVision ? foxExpiry : 0
        };
    });
}

function broadcastRoomState(room) {
    room.players.forEach(p => {
        io.to(p.id).emit('sync_players', {
            players: getClientFilteredPlayers(room, p.id),
            deckCount: room.deck.length,
            currentTurnId: room.players[room.currentTurnIndex].id
        });
    });
}

io.on('connection', (socket) => {
    function generateRoomCode() {
        return Math.random().toString(36).substring(2, 6).toUpperCase();
    }

    socket.on('create_room', (playerName) => {
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            host: socket.id,
            deck: [],
            players: [{ id: socket.id, name: playerName, card: null, score: 0, knownCards: {} }],
            status: 'waiting',
            currentTurnIndex: 0,
            pendingGroup: null,
            foxVisionExpiry: {}
        };
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
    });

    socket.on('join_room', ({ roomCode, playerName }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error_message', '找不到房間！');
        if (room.status === 'playing') return socket.emit('error_message', '遊戲已經開始！');

        room.players.push({ id: socket.id, name: playerName, card: null, score: 0, knownCards: {} });
        socket.join(roomCode);
        
        room.players.forEach(p => {
            io.to(p.id).emit('update_players', getClientFilteredPlayers(room, p.id));
        });
    });

    socket.on('start_game', (roomCode) => {
        const room = rooms[roomCode];
        if (!room || room.host !== socket.id) return;

        room.status = 'playing';
        room.deck = createDeck();
        room.currentTurnIndex = 0;
        room.foxVisionExpiry = {};

        room.players.forEach(p => {
            p.card = room.deck.pop();
            p.knownCards = {};
            p.knownCards[p.id] = true;
        });

        broadcastRoomState(room);
        io.to(roomCode).emit('game_started_signal');
    });

    function nextTurn(room) {
        if (room.foxVisionExpiry) {
            Object.keys(room.foxVisionExpiry).forEach(viewerId => {
                Object.keys(room.foxVisionExpiry[viewerId]).forEach(targetId => {
                    if (room.foxVisionExpiry[viewerId][targetId] > 0) {
                        room.foxVisionExpiry[viewerId][targetId] -= 1;
                        if (room.foxVisionExpiry[viewerId][targetId] <= 0) {
                            delete room.foxVisionExpiry[viewerId][targetId];
                        }
                    }
                });
            });
        }

        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        if (room.deck.length === 0) {
            room.status = 'ended';
            io.to(room.code).emit('game_over', room.players);
        } else {
            broadcastRoomState(room);
        }
    }

    function revealCardBetween(p1, p2) {
        if (!p1.knownCards) p1.knownCards = {};
        if (!p2.knownCards) p2.knownCards = {};
        p1.knownCards[p2.id] = true;
        p2.knownCards[p1.id] = true;
    }

    function executeDuel(room, actor, target, roomCode) {
        revealCardBetween(actor, target);

        let actorWin = false;
        if (actor.card.isBacteria) actorWin = true;
        else if (target.card.isBacteria) actorWin = false;
        else {
            actorWin = (actor.card.points >= target.card.points);
        }

        let log = '';
        if (actorWin) {
            actor.score += target.card.points;
            log = `⚔️ 【單挑】${actor.name} 擊敗了 ${target.name}，獲得 ${target.card.points} 分！`;
            io.to(actor.id).emit('play_sound', 'win');
            io.to(target.id).emit('play_sound', 'lose');

            if (target.card.isLion) {
                log += ` 🦁【獅之同歸於盡】${target.name} 的獅在倒下時發動反撲，雙方同時更換手牌！`;
                if (room.deck.length > 0) {
                    actor.card = room.deck.pop();
                    actor.knownCards = {};
                    actor.knownCards[actor.id] = true;
                }
            }

            if (room.deck.length > 0) {
                target.card = room.deck.pop();
                target.knownCards = {};
                target.knownCards[target.id] = true;
            }
        } else {
            target.score += actor.card.points;
            log = `⚔️ 【單挑】${actor.name} 輸給了 ${target.name}，對手獲得 ${actor.card.points} 分！`;
            io.to(actor.id).emit('play_sound', 'win');
            io.to(target.id).emit('play_sound', 'lose');

            if (room.deck.length > 0) {
                actor.card = room.deck.pop();
                actor.knownCards = {};
                actor.knownCards[actor.id] = true;
            }
        }

        io.to(roomCode).emit('append_log', log);
        nextTurn(room);
    }

    function resolveGroupInternal(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.pendingGroup) return;

        const g = room.pendingGroup;
        const actor = room.players.find(p => p.id === g.attackerId);
        const target = room.players.find(p => p.id === g.targetId);
        const participants = room.players.filter(p => g.participants.includes(p.id));

        room.pendingGroup = null;

        if (participants.length <= 1) {
            io.to(roomCode).emit('append_log', '⚠️ 無其他人參加圍毆，自動轉為單挑模式！');
            executeDuel(room, actor, target, roomCode);
            return;
        }

        for (let i = 0; i < participants.length; i++) {
            for (let j = i + 1; j < participants.length; j++) {
                revealCardBetween(participants[i], participants[j]);
            }
        }
        participants.forEach(p => revealCardBetween(p, target));
        revealCardBetween(target, actor);

        let participantDetails = participants.map(p => `${p.name}(${p.card.emoji} ${p.card.name})`).join(', ');
        
        // 檢查是否有「狡兔三窟」條件：圍毆方有 2 張或以上的兔子 (isRabbit)
        const rabbits = participants.filter(p => p.card.isRabbit);
        let log = '';

        if (rabbits.length >= 2) {
            // 發動狡兔三窟技能：直接打敗被圍毆者，兩張兔子各得 5 分
            rabbits.forEach(r => {
                r.score += 5;
            });

            log = `🐰 【狡兔三窟】參與者中包含 ${rabbits.length} 張兔子！發動狡兔三窟技能，直接打敗被圍毆者 ${target.name}！每隻兔子獲得 5 分。`;
            participants.forEach(p => io.to(p.id).emit('play_sound', 'win'));
            io.to(target.id).emit('play_sound', 'lose');

            if (target.card.isLion) {
                log += ` 🦁【獅之同歸於盡】${target.name} 的獅在圍攻下倒下，發動反撲與牌面最小的 ${rabbits[0].name} 同時更換手牌！`;
                if (room.deck.length > 0) {
                    rabbits[0].card = room.deck.pop();
                    rabbits[0].knownCards = {};
                    rabbits[0].knownCards[rabbits[0].id] = true;
                }
            }

            if (room.deck.length > 0) {
                target.card = room.deck.pop();
                target.knownCards = {};
                target.knownCards[target.id] = true;
            }

        } else {
            let totalTeamPower = participants.reduce((sum, p) => sum + p.card.points, 0);
            let targetPower = target.card.points;

            if (target.card.isHunter) {
                targetPower += participants.length;
            }

            if (target.card.isBacteria) {
                log = `🛡️ 【圍毆失敗】參與者 [${participantDetails}] 圍攻細菌 ${target.name} 失敗！細菌無限大無法被戰勝。`;
                participants.forEach(p => io.to(p.id).emit('play_sound', 'lose'));
                io.to(target.id).emit('play_sound', 'win');
            } else if (totalTeamPower >= targetPower) {
                participants.sort((a, b) => a.card.points - b.card.points);
                let lowestWinner = participants[0];
                lowestWinner.score += target.card.points;
                
                log = `🛡️ 【圍毆成功】參與者 [${participantDetails}] 總分 ${totalTeamPower} 大於等於 ${target.name} (${targetPower})！牌面最小的 ${lowestWinner.name} 獲得 ${target.card.points} 分！`;
                
                participants.forEach(p => io.to(p.id).emit('play_sound', 'win'));
                io.to(target.id).emit('play_sound', 'lose');

                if (target.card.isLion) {
                    log += ` 🦁【獅之同歸於盡】${target.name} 的獅在圍攻下倒下，發動反撲與牌面最小的 ${lowestWinner.name} 同時更換手牌！`;
                    if (room.deck.length > 0) {
                        lowestWinner.card = room.deck.pop();
                        lowestWinner.knownCards = {};
                        lowestWinner.knownCards[lowestWinner.id] = true;
                    }
                }

                if (room.deck.length > 0) {
                    target.card = room.deck.pop();
                    target.knownCards = {};
                    target.knownCards[target.id] = true;
                }
            } else {
                log = `🛡️ 【圍毆失敗】參與者 [${participantDetails}] 總分 ${totalTeamPower} 不足 ${targetPower}，被圍毆者 ${target.name} 成功守住！`;
                participants.forEach(p => io.to(p.id).emit('play_sound', 'lose'));
                io.to(target.id).emit('play_sound', 'win');
            }
        }

        io.to(roomCode).emit('append_log', log);
        nextTurn(room);
    }

    socket.on('player_action', ({ roomCode, actionType, targetId }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const actor = room.players.find(p => p.id === socket.id);
        if (!actor) return;
        room.code = roomCode;

        if (actor.card.isBacteria && (actionType === 'attack' || actionType === 'group_attack')) {
            return socket.emit('error_message', '細菌牌無法發起單挑或圍毆！');
        }

        if (actionType === 'attack') {
            const target = room.players.find(p => p.id === targetId);
            if (!target || target.id === actor.id) return;
            executeDuel(room, actor, target, roomCode);

        } else if (actionType === 'group_attack') {
            const target = room.players.find(p => p.id === targetId);
            if (!target || target.id === actor.id) return;

            room.pendingGroup = {
                attackerId: actor.id,
                targetId: targetId,
                participants: [actor.id]
            };

            room.players.forEach(p => {
                if (p.id !== actor.id && p.id !== targetId && !p.card.isBacteria && !p.card.isHunter) {
                    io.to(p.id).emit('prompt_group_vote', {
                        initiator: actor.name,
                        targetName: target.name
                    });
                }
            });

            io.to(roomCode).emit('start_group_vote', {
                initiator: actor.name,
                targetName: target.name
            });

            setTimeout(() => {
                if (room.pendingGroup && room.pendingGroup.attackerId === actor.id) {
                    resolveGroupInternal(roomCode);
                }
            }, 5000);

        } else if (actionType === 'discard') {
            const wasFox = (actor.card.name === '狐狸');
            actor.score -= 1;
            
            if (room.deck.length > 0) {
                actor.card = room.deck.pop();
                actor.knownCards = {};
                actor.knownCards[actor.id] = true;
            }

            if (wasFox) {
                if (!room.foxVisionExpiry) room.foxVisionExpiry = {};
                room.foxVisionExpiry[actor.id] = {};
                room.players.forEach(p => {
                    if (p.id !== actor.id) {
                        room.foxVisionExpiry[actor.id][p.id] = 3;
                    }
                });
                io.to(roomCode).emit('append_log', `🦊 【狐狸特權】${actor.name} 捨棄了狐狸並換新卡，獲得看穿所有對手手牌的能力，持續 3 個回合！`);
            } else {
                io.to(roomCode).emit('append_log', `🔄 【棄牌】${actor.name} 棄牌換新卡 (-1分)。`);
            }

            nextTurn(room);

        } else if (actionType === 'pass') {
            io.to(roomCode).emit('append_log', `💤 【Pass】${actor.name} Pass。`);
            nextTurn(room);
        }
    });

    socket.on('respond_group', ({ roomCode, join }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingGroup) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || socket.id === room.pendingGroup.attackerId || socket.id === room.pendingGroup.targetId) return;

        if (player.card.isBacteria || player.card.isHunter) return;

        if (join && !room.pendingGroup.participants.includes(socket.id)) {
            room.pendingGroup.participants.push(socket.id);
        }
    });

    socket.on('timeout_action', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const actor = room.players[room.currentTurnIndex];
        let otherPlayers = room.players.filter(p => p.id !== actor.id);
        if (otherPlayers.length === 0) return;

        if (actor.card.isBacteria) {
            actor.score -= 1;
            if (room.deck.length > 0) {
                actor.card = room.deck.pop();
                actor.knownCards = {};
                actor.knownCards[actor.id] = true;
            }
            io.to(roomCode).emit('append_log', `⏱️ 【逾時自動】${actor.name} (細菌) 未能在 10 秒內決定，自動棄牌換卡 (-1分)。`);
            nextTurn(room);
        } else {
            const target = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
            io.to(roomCode).emit('append_log', `⏱️ 【逾時自動】${actor.name} 未能在 10 秒內決定，自動隨機單挑 ${target.name}！`);
            executeDuel(room, actor, target, roomCode);
        }
    });
});

server.listen(3000, () => {
    console.log('伺服器已啟動！');
});