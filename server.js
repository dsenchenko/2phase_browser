const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static('public'));

// Game state
const games = new Map();
const players = new Map();
const matchmakingQueue = [];
let matchmakingTimer = null;

// Game constants
const GAME_CONFIG = {
    PLANNING_TIME: 60000, // 1 minute in milliseconds
    MAP_WIDTH: 1600, // Increased for larger map
    MAP_HEIGHT: 1000,  // Increased for larger map
    GRID_SIZE: 40,
    UNIT_SIZE: 20,
    MIN_PLAYERS: 2,
    MAX_PLAYERS: 6, // Increased to support 6 players
    MATCHMAKING_WAIT_TIME: 10000, // 10 seconds
    VISION_RANGE: 8, // cells - doubled vision range
    TIMELINE_DURATION: 20, // seconds for execution phase
    TIME_PER_MOVE: 0.5, // seconds per grid cell movement - faster for larger map
    TIME_PER_ATTACK: 5, // seconds for attack action
    TIME_WAIT: 1 // seconds for wait action
};

// Grid utilities
function worldToGrid(x, y) {
    return {
        x: Math.floor(x / GAME_CONFIG.GRID_SIZE),
        y: Math.floor(y / GAME_CONFIG.GRID_SIZE)
    };
}

function gridToWorld(gridX, gridY) {
    return {
        x: gridX * GAME_CONFIG.GRID_SIZE + GAME_CONFIG.GRID_SIZE / 2,
        y: gridY * GAME_CONFIG.GRID_SIZE + GAME_CONFIG.GRID_SIZE / 2
    };
}

function getGridDistance(pos1, pos2) {
    return Math.abs(pos1.x - pos2.x) + Math.abs(pos1.y - pos2.y);
}

// Simple A* pathfinding
function findPath(start, end, obstacles) {
    const gridWidth = Math.ceil(GAME_CONFIG.MAP_WIDTH / GAME_CONFIG.GRID_SIZE);
    const gridHeight = Math.ceil(GAME_CONFIG.MAP_HEIGHT / GAME_CONFIG.GRID_SIZE);
    
    if (start.x === end.x && start.y === end.y) return [start];
    if (end.x < 0 || end.x >= gridWidth || end.y < 0 || end.y >= gridHeight) return [];
    
    const openSet = [{ ...start, g: 0, h: getGridDistance(start, end), f: getGridDistance(start, end), parent: null }];
    const closedSet = new Set();
    
    while (openSet.length > 0) {
        openSet.sort((a, b) => a.f - b.f);
        const current = openSet.shift();
        const currentKey = `${current.x},${current.y}`;
        
        if (current.x === end.x && current.y === end.y) {
            const path = [];
            let node = current;
            while (node) {
                path.unshift({ x: node.x, y: node.y });
                node = node.parent;
            }
            return path;
        }
        
        closedSet.add(currentKey);
        
        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 }
        ];
        
        for (const neighbor of neighbors) {
            const neighborKey = `${neighbor.x},${neighbor.y}`;
            
            if (neighbor.x < 0 || neighbor.x >= gridWidth || 
                neighbor.y < 0 || neighbor.y >= gridHeight ||
                closedSet.has(neighborKey) ||
                obstacles.has(neighborKey)) {
                continue;
            }
            
            const g = current.g + 1;
            const h = getGridDistance(neighbor, end);
            const f = g + h;
            
            const existingNode = openSet.find(n => n.x === neighbor.x && n.y === neighbor.y);
            if (!existingNode) {
                openSet.push({ ...neighbor, g, h, f, parent: current });
            } else if (g < existingNode.g) {
                existingNode.g = g;
                existingNode.f = g + h;
                existingNode.parent = current;
            }
        }
    }
    
    return []; // No path found
}

// Matchmaking system
function addToMatchmakingQueue(playerId, username, socketId) {
    const player = {
        id: playerId,
        username: username,
        socketId: socketId,
        joinTime: Date.now()
    };
    
    matchmakingQueue.push(player);
    console.log(`Player ${username} (${playerId}) joined matchmaking queue. Queue size: ${matchmakingQueue.length}`);
    
    // Start matchmaking timer if this is the first player
    if (matchmakingQueue.length === 1) {
        startMatchmakingTimer();
    }
    
    // Broadcast queue update to all waiting players
    broadcastMatchmakingUpdate();
    
    // If we have max players, start immediately
    if (matchmakingQueue.length >= GAME_CONFIG.MAX_PLAYERS) {
        startGameFromQueue();
    }
}

function removeFromMatchmakingQueue(socketId) {
    const index = matchmakingQueue.findIndex(p => p.socketId === socketId);
    if (index !== -1) {
        const player = matchmakingQueue.splice(index, 1)[0];
        console.log(`Player ${player.username} left matchmaking queue`);
        
        // If queue is empty, clear timer
        if (matchmakingQueue.length === 0 && matchmakingTimer) {
            clearInterval(matchmakingTimer);
            matchmakingTimer = null;
        } else {
            broadcastMatchmakingUpdate();
        }
    }
}

function startMatchmakingTimer() {
    let timeRemaining = GAME_CONFIG.MATCHMAKING_WAIT_TIME / 1000; // Convert to seconds
    
    matchmakingTimer = setInterval(() => {
        timeRemaining--;
        broadcastMatchmakingUpdate(timeRemaining);
        
        if (timeRemaining <= 0) {
            clearInterval(matchmakingTimer);
            matchmakingTimer = null;
            
            // Start game if we have at least minimum players
            if (matchmakingQueue.length >= GAME_CONFIG.MIN_PLAYERS) {
                startGameFromQueue();
            } else {
                // Reset timer if we still have players but not enough
                if (matchmakingQueue.length > 0) {
                    startMatchmakingTimer();
                }
            }
        }
    }, 1000);
}

function broadcastMatchmakingUpdate(timeRemaining = null) {
    if (matchmakingQueue.length === 0) return;
    
    const updateData = {
        players: matchmakingQueue.map(p => ({ id: p.id, username: p.username })),
        timeRemaining: timeRemaining
    };
    
    matchmakingQueue.forEach(player => {
        io.to(player.socketId).emit('matchmakingUpdate', updateData);
    });
}

function startGameFromQueue() {
    if (matchmakingQueue.length < GAME_CONFIG.MIN_PLAYERS) return;
    
    const gameId = uuidv4();
    const game = new Game(gameId);
    games.set(gameId, game);
    
    // Add all queued players to the game
    const playersToAdd = matchmakingQueue.splice(0, GAME_CONFIG.MAX_PLAYERS);
    
    playersToAdd.forEach(player => {
        const socket = io.sockets.sockets.get(player.socketId);
        if (socket) {
            players.set(player.socketId, player.id);
            game.addPlayer(player.id, player.socketId, player.username);
            socket.join(gameId);
            socket.emit('joined', { 
                playerId: player.id, 
                gameId: gameId,
                playerColor: game.players.find(p => p.id === player.id).color
            });
        }
    });
    
    console.log(`Game ${gameId} started with ${playersToAdd.length} players`);
    
    // Notify all players that the game has started
    io.to(gameId).emit('gameStarted', { 
        playerCount: playersToAdd.length,
        gameId: gameId 
    });
    
    game.broadcastGameState();
    
    // Clear timer if it's still running
    if (matchmakingTimer) {
        clearInterval(matchmakingTimer);
        matchmakingTimer = null;
    }
    
    // If there are still players in queue, restart matchmaking
    if (matchmakingQueue.length > 0) {
        startMatchmakingTimer();
    }
}

class Command {
    constructor(type, data, startTime, duration) {
        this.type = type; // 'move', 'attack', 'wait'
        this.data = data; // command-specific data
        this.startTime = startTime; // when to start (in timeline seconds)
        this.duration = duration; // how long it takes
        this.endTime = startTime + duration;
        this.executed = false;
    }
}

class Unit {
    constructor(id, gridX, gridY, playerId, type = 'soldier') {
        this.id = id;
        this.gridX = gridX;
        this.gridY = gridY;
        const worldPos = gridToWorld(gridX, gridY);
        this.x = worldPos.x;
        this.y = worldPos.y;
        this.playerId = playerId;
        this.type = type;
        this.health = 100;
        this.maxHealth = 100;
        this.damage = 25;
        this.shootRange = 5; // grid cells
        this.visionRange = GAME_CONFIG.VISION_RANGE;
        this.selected = false;
        
        // Timeline-based command system
        this.commandChain = []; // array of Command objects
        this.currentCommand = null;
        this.commandStartTime = 0;
        
        // Movement state
        this.isMoving = false;
        this.moveStartGrid = null;
        this.moveTargetGrid = null;
        this.moveProgress = 0;
        
        // Sector watching state
        this.isWatching = false;
        this.watchData = null;
    }

    addCommand(type, data) {
        const startTime = this.getNextAvailableTime();
        let duration;
        
        switch (type) {
            case 'move':
                const pathLength = data.path ? data.path.length - 1 : 0;
                duration = pathLength * GAME_CONFIG.TIME_PER_MOVE;
                break;
            case 'attack':
                duration = GAME_CONFIG.TIME_PER_ATTACK;
                break;
            case 'wait':
                duration = data.duration || GAME_CONFIG.TIME_WAIT;
                break;
            default:
                duration = 1;
        }
        
        // Check if adding this command would exceed timeline limit
        const endTime = startTime + duration;
        if (endTime > GAME_CONFIG.TIMELINE_DURATION) {
            return null; // Cannot add command - would exceed timeline
        }
        
        const command = new Command(type, data, startTime, duration);
        this.commandChain.push(command);
        return command;
    }

    insertCommand(index, type, data) {
        const command = this.addCommand(type, data);
        // Remove from end and insert at index
        this.commandChain.pop();
        this.commandChain.splice(index, 0, command);
        this.recalculateTimeline();
        return command;
    }

    removeCommand(index) {
        if (index >= 0 && index < this.commandChain.length) {
            this.commandChain.splice(index, 1);
            this.recalculateTimeline();
        }
    }

    recalculateTimeline() {
        let currentTime = 0;
        this.commandChain.forEach(command => {
            command.startTime = currentTime;
            command.endTime = currentTime + command.duration;
            currentTime = command.endTime;
        });
    }

    getNextAvailableTime() {
        if (this.commandChain.length === 0) return 0;
        return this.commandChain[this.commandChain.length - 1].endTime;
    }

    getTotalTimelineLength() {
        return this.getNextAvailableTime();
    }

    getLastCommandEndPosition() {
        if (this.commandChain.length === 0) {
            return { x: this.gridX, y: this.gridY };
        }
        
        // Find the last move command to get the final position
        for (let i = this.commandChain.length - 1; i >= 0; i--) {
            const command = this.commandChain[i];
            if (command.type === 'move' && command.data.path && command.data.path.length > 0) {
                const finalPoint = command.data.path[command.data.path.length - 1];
                return { x: finalPoint.x, y: finalPoint.y };
            }
        }
        
        // If no move commands found, return current position
        return { x: this.gridX, y: this.gridY };
    }

    planMove(targetGridX, targetGridY, obstacles, game) {
        // Add other units' positions as obstacles
        const occupied = new Set([...obstacles]);
        game.units.forEach(u => {
            if (u.id !== this.id && u.health > 0) {
                occupied.add(`${u.gridX},${u.gridY}`);
            }
        });
        const start = this.getLastCommandEndPosition();
        const end = { x: targetGridX, y: targetGridY };
        const path = findPath(start, end, occupied);
        if (path.length > 1) {
            const command = this.addCommand('move', { path: path });
            return command !== null; // Return success/failure
        }
        return false;
    }

    planWait(duration) {
        const command = this.addCommand('wait', { duration: duration });
        return command !== null; // Return success/failure
    }

    planWatchSector(gridX, gridY, direction, angle, duration) {
        console.log(`Planning watchSector: gridX=${gridX}, gridY=${gridY}, direction=${direction}, duration=${duration}`);
        const command = this.addCommand('watchSector', { 
            gridX, 
            gridY, 
            direction, // angle in radians
            angle,     // cone width in radians
            duration   // how long to watch
        });
        console.log(`WatchSector command added: ${command !== null}, total commands: ${this.commandChain.length}`);
        return command !== null;
    }

    updateExecution(game, currentTime, deltaTime) {
        // Start new command if needed
        if (!this.currentCommand) {
            const nextCommand = this.commandChain.find(cmd => 
                !cmd.executed && cmd.startTime <= currentTime
            );
            
            if (nextCommand) {
                console.log(`Unit ${this.id.substring(0, 8)} starting command: ${nextCommand.type} at time ${currentTime.toFixed(2)}s`);
                this.currentCommand = nextCommand;
                this.commandStartTime = currentTime;
                this.startCommand(nextCommand, game);
            }
        }
        
        // Update current command
        if (this.currentCommand) {
            const commandElapsed = currentTime - this.commandStartTime;
            const commandProgress = Math.min(commandElapsed / this.currentCommand.duration, 1.0);
            
            if (commandProgress >= 1.0) {
                // Command finished
                console.log(`Unit ${this.id.substring(0, 8)} finishing command: ${this.currentCommand.type} after ${commandElapsed.toFixed(2)}s`);
                this.finishCommand(this.currentCommand, game);
                this.currentCommand.executed = true;
                this.currentCommand = null;
                this.commandStartTime = null;
            } else {
                // Command in progress
                this.updateCommand(this.currentCommand, commandProgress, game, deltaTime);
            }
        }
    }

    startCommand(command, game) {
        switch (command.type) {
            case 'move':
                if (command.data.path && command.data.path.length > 1) {
                    this.isMoving = true;
                    this.moveProgress = 0;
                    
                    console.log(`Unit ${this.id.substring(0, 8)} starting move from (${this.gridX}, ${this.gridY}) to path:`, 
                        command.data.path.map(p => `(${p.x}, ${p.y})`).join(' -> '));
                    
                    // Ensure the unit starts from the correct position
                    // The path should already be calculated from the unit's current position
                    const pathStart = command.data.path[0];
                    if (pathStart.x !== this.gridX || pathStart.y !== this.gridY) {
                        console.log(`Warning: Path starts from (${pathStart.x}, ${pathStart.y}) but unit is at (${this.gridX}, ${this.gridY})`);
                        // Don't force position change - trust the current position
                    }
                }
                break;
            case 'watchSector':
                // Start watching the sector - move to sector position
                this.isWatching = true;
                this.watchData = command.data;
                this.isMoving = true;
                this.moveStartGrid = { x: this.gridX, y: this.gridY };
                this.moveTargetGrid = { x: command.data.gridX, y: command.data.gridY };
                this.moveProgress = 0;
                break;
            case 'wait':
                // Nothing to start for wait
                break;
        }
    }

    updateCommand(command, progress, game, deltaTime) {
        switch (command.type) {
            case 'move':
                if (this.isMoving && command.data.path && command.data.path.length > 1) {
                    // Smooth movement along entire path based on overall progress
                    const totalDistance = command.data.path.length - 1;
                    const currentDistance = progress * totalDistance;
                    const currentStep = Math.floor(currentDistance);
                    const stepProgress = currentDistance - currentStep;
                    
                    // Ensure we don't go beyond the path
                    const fromIndex = Math.min(currentStep, command.data.path.length - 1);
                    const toIndex = Math.min(currentStep + 1, command.data.path.length - 1);
                    
                    const from = command.data.path[fromIndex];
                    const to = command.data.path[toIndex];
                    
                    if (from && to && from.x !== undefined && from.y !== undefined && 
                        to.x !== undefined && to.y !== undefined) {
                        const fromWorld = gridToWorld(from.x, from.y);
                        const toWorld = gridToWorld(to.x, to.y);
                        
                        // Smooth interpolation between current step positions
                        this.x = fromWorld.x + (toWorld.x - fromWorld.x) * stepProgress;
                        this.y = fromWorld.y + (toWorld.y - fromWorld.y) * stepProgress;
                        
                        // Update grid position to the closest grid cell
                        const currentWorldPos = { x: this.x, y: this.y };
                        const gridPos = worldToGrid(currentWorldPos.x, currentWorldPos.y);
                        this.gridX = gridPos.x;
                        this.gridY = gridPos.y;
                    }
                }
                break;
            case 'watchSector':
                // Move to sector position and watch
                if (this.isMoving && this.moveStartGrid && this.moveTargetGrid) {
                    // Smooth movement to sector position
                    const fromWorld = gridToWorld(this.moveStartGrid.x, this.moveStartGrid.y);
                    const toWorld = gridToWorld(this.moveTargetGrid.x, this.moveTargetGrid.y);
                    
                    this.x = fromWorld.x + (toWorld.x - fromWorld.x) * progress;
                    this.y = fromWorld.y + (toWorld.y - fromWorld.y) * progress;
                    
                    // Update grid position when crossing boundaries
                    if (progress > 0.5) {
                        this.gridX = this.moveTargetGrid.x;
                        this.gridY = this.moveTargetGrid.y;
                    } else {
                        this.gridX = this.moveStartGrid.x;
                        this.gridY = this.moveStartGrid.y;
                    }
                }
                
                // Check for enemies in sector and auto-fire
                if (this.isWatching) {
                    this.checkSectorForEnemies(game);
                }
                break;
        }
    }

    finishCommand(command, game) {
        switch (command.type) {
            case 'move':
                if (command.data.path && command.data.path.length > 0) {
                    const finalPos = command.data.path[command.data.path.length - 1];
                    if (finalPos && finalPos.x !== undefined && finalPos.y !== undefined) {
                        this.gridX = finalPos.x;
                        this.gridY = finalPos.y;
                        const worldPos = gridToWorld(this.gridX, this.gridY);
                        this.x = worldPos.x;
                        this.y = worldPos.y;
                        
                        console.log(`Unit ${this.id.substring(0, 8)} finished move at (${this.gridX}, ${this.gridY})`);
                    }
                }
                this.isMoving = false;
                this.moveProgress = 0;
                break;
            case 'watchSector':
                // Finish moving to sector position and stop watching
                if (this.moveTargetGrid && this.moveTargetGrid.x !== undefined && this.moveTargetGrid.y !== undefined) {
                    this.gridX = this.moveTargetGrid.x;
                    this.gridY = this.moveTargetGrid.y;
                    const worldPos = gridToWorld(this.gridX, this.gridY);
                    this.x = worldPos.x;
                    this.y = worldPos.y;
                }
                this.isMoving = false;
                this.isWatching = false;
                this.watchData = null;
                break;
            case 'wait':
                // Nothing to finish for wait
                break;
        }
    }

    checkSectorForEnemies(game) {
        if (!this.watchData) return;
        
        const enemies = game.units.filter(unit => 
            unit.playerId !== this.playerId && 
            unit.health > 0 &&
            this.isInSector(unit) &&
            this.canAttack(unit)
        );
        
        // Auto-fire at the first enemy in sector
        if (enemies.length > 0) {
            const target = enemies[0];
            target.takeDamage(this.damage);
            
            // Add shooting effect data for client
            if (!game.shootingEffects) game.shootingEffects = [];
            game.shootingEffects.push({
                from: { x: this.x, y: this.y },
                to: { x: target.x, y: target.y },
                timestamp: Date.now()
            });
        }
    }

    isInSector(target) {
        if (!this.watchData) return false;
        
        const sectorPos = { x: this.watchData.gridX, y: this.watchData.gridY };
        const targetPos = { x: target.gridX, y: target.gridY };
        
        // Check if target is within range
        const distance = getGridDistance(sectorPos, targetPos);
        if (distance > this.shootRange) return false;
        
        // Check if target is within the cone angle
        const dx = targetPos.x - sectorPos.x;
        const dy = targetPos.y - sectorPos.y;
        const targetAngle = Math.atan2(dy, dx);
        
        const angleDiff = Math.abs(targetAngle - this.watchData.direction);
        const normalizedDiff = Math.min(angleDiff, 2 * Math.PI - angleDiff);
        
        return normalizedDiff <= this.watchData.angle / 2;
    }

    canAttack(target) {
        const distance = getGridDistance(
            { x: this.gridX, y: this.gridY },
            { x: target.gridX, y: target.gridY }
        );
        return distance <= this.shootRange && target.playerId !== this.playerId;
    }

    canSee(target) {
        const distance = getGridDistance(
            { x: this.gridX, y: this.gridY },
            { x: target.gridX, y: target.gridY }
        );
        return distance <= this.visionRange;
    }

    takeDamage(damage) {
        this.health -= damage;
        if (this.health <= 0) {
            this.health = 0;
        }
    }

    clearCommands() {
        this.commandChain = [];
        this.currentCommand = null;
        this.commandStartTime = 0;
        this.isMoving = false;
        this.moveStartGrid = null;
        this.moveTargetGrid = null;
        this.moveProgress = 0;
        this.isWatching = false;
        this.watchData = null;
    }
}

class Game {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.units = [];
        this.obstacles = new Set();
        this.phase = 'waiting'; // waiting, planning, executing
        this.planningTimer = null;
        this.executionTimer = null;
        this.planningTimeLeft = GAME_CONFIG.PLANNING_TIME;
        
        this.generateObstacles();
    }

    generateObstacles() {
        const gridWidth = Math.ceil(GAME_CONFIG.MAP_WIDTH / GAME_CONFIG.GRID_SIZE);
        const gridHeight = Math.ceil(GAME_CONFIG.MAP_HEIGHT / GAME_CONFIG.GRID_SIZE);
        const centerY = Math.floor(gridHeight / 2);
        const centerX = Math.floor(gridWidth / 2);
        
        // Define all possible spawn areas to avoid
        const spawnAreas = [
            // 2-player spawn areas
            { x: 1, y: centerY, radius: 2 },              // Left side
            { x: gridWidth - 2, y: centerY, radius: 2 },  // Right side
            // 3-4 player additional spawn areas
            { x: centerX, y: 1, radius: 2 },              // Top side
            { x: centerX, y: gridHeight - 2, radius: 2 }  // Bottom side
        ];
        
        // Generate random obstacles (about 15% of the map)
        const obstacleCount = Math.floor(gridWidth * gridHeight * 0.15);
        
        for (let i = 0; i < obstacleCount; i++) {
            let x, y;
            let attempts = 0;
            do {
                x = Math.floor(Math.random() * gridWidth);
                y = Math.floor(Math.random() * gridHeight);
                attempts++;
                
                // Avoid infinite loop
                if (attempts > 1000) break;
                
            } while (
                this.obstacles.has(`${x},${y}`) ||
                spawnAreas.some(area => {
                    const distance = Math.abs(x - area.x) + Math.abs(y - area.y);
                    return distance <= area.radius;
                })
            );
            
            if (attempts <= 1000) {
                this.obstacles.add(`${x},${y}`);
            }
        }
    }

    addPlayer(playerId, socketId, username) {
        if (this.players.length >= GAME_CONFIG.MAX_PLAYERS) {
            return false;
        }

        // Define colors for up to 6 players
        const playerColors = ['#4CAF50', '#F44336', '#2196F3', '#FF9800', '#9C27B0', '#00BCD4']; // Green, Red, Blue, Orange, Purple, Cyan

        const player = {
            id: playerId,
            socketId: socketId,
            username: username,
            ready: false,
            planningReady: false,
            color: playerColors[this.players.length]
        };

        this.players.push(player);
        this.spawnUnitsForPlayer(playerId);

        // Start planning when we have at least minimum players and all current players are ready
        // Or when we reach max players
        if (this.players.length >= GAME_CONFIG.MIN_PLAYERS) {
            // For now, start immediately when we have enough players
            // Could add a ready system here later
            this.startPlanningPhase();
        }

        return true;
    }

    spawnUnitsForPlayer(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        const gridWidth = Math.ceil(GAME_CONFIG.MAP_WIDTH / GAME_CONFIG.GRID_SIZE);
        const gridHeight = Math.ceil(GAME_CONFIG.MAP_HEIGHT / GAME_CONFIG.GRID_SIZE);
        
        // Define spawn positions for up to 6 players
        let spawnPositions;
        const centerY = Math.floor(gridHeight / 2);
        const centerX = Math.floor(gridWidth / 2);
        const quarterX = Math.floor(gridWidth / 4);
        const threeQuarterX = Math.floor(3 * gridWidth / 4);
        
        if (this.players.length <= 2) {
            // 2 players: left and right sides
            spawnPositions = [
                { x: 1, y: centerY },      // Player 1: left side
                { x: gridWidth - 2, y: centerY }  // Player 2: right side
            ];
        } else if (this.players.length <= 3) {
            // 3 players: left, right, top
            spawnPositions = [
                { x: 1, y: centerY },              // Player 1: left side
                { x: gridWidth - 2, y: centerY },  // Player 2: right side
                { x: centerX, y: 1 }               // Player 3: top side
            ];
        } else if (this.players.length <= 4) {
            // 4 players: all four corners/sides
            spawnPositions = [
                { x: 1, y: centerY },              // Player 1: left side
                { x: gridWidth - 2, y: centerY },  // Player 2: right side
                { x: centerX, y: 1 },              // Player 3: top side
                { x: centerX, y: gridHeight - 2 }  // Player 4: bottom side
            ];
        } else if (this.players.length <= 5) {
            // 5 players: four sides + one corner
            spawnPositions = [
                { x: 1, y: centerY },              // Player 1: left side
                { x: gridWidth - 2, y: centerY },  // Player 2: right side
                { x: centerX, y: 1 },              // Player 3: top side
                { x: centerX, y: gridHeight - 2 }, // Player 4: bottom side
                { x: 1, y: 1 }                     // Player 5: top-left corner
            ];
        } else {
            // 6 players: four sides + two corners
            spawnPositions = [
                { x: 1, y: centerY },              // Player 1: left side
                { x: gridWidth - 2, y: centerY },  // Player 2: right side
                { x: centerX, y: 1 },              // Player 3: top side
                { x: centerX, y: gridHeight - 2 }, // Player 4: bottom side
                { x: 1, y: 1 },                    // Player 5: top-left corner
                { x: gridWidth - 2, y: gridHeight - 2 } // Player 6: bottom-right corner
            ];
        }

        const spawnPos = spawnPositions[playerIndex];

        // Spawn 3 units for each player in a small formation
        const unitOffsets = [
            { x: 0, y: -1 },  // Unit above
            { x: 0, y: 0 },   // Unit center
            { x: 0, y: 1 }    // Unit below
        ];

        for (let i = 0; i < 3; i++) {
            const offset = unitOffsets[i];
            const unit = new Unit(
                uuidv4(),
                spawnPos.x + offset.x,
                spawnPos.y + offset.y,
                playerId
            );
            this.units.push(unit);
        }
    }

    startPlanningPhase() {
        this.phase = 'planning';
        this.planningTimeLeft = GAME_CONFIG.PLANNING_TIME;
        
        // Clear previous commands and reset ready states
        this.units.forEach(unit => unit.clearCommands());
        this.players.forEach(player => player.planningReady = false);

        this.planningTimer = setInterval(() => {
            this.planningTimeLeft -= 1000;
            
            if (this.planningTimeLeft <= 0 && this.phase === 'planning') {
                this.startExecutionPhase();
            }
        }, 1000);

        this.broadcastGameState();
    }

    setPlayerReady(playerId, ready) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.planningReady = ready;
            
            // Check if all players are ready
            const allReady = this.players.every(p => p.planningReady);
            if (allReady && this.phase === 'planning') {
                this.startExecutionPhase();
            }
            
            this.broadcastGameState();
        }
    }

    startExecutionPhase() {
        // Prevent multiple execution phases from running
        if (this.phase === 'executing' || this.executionTimer) {
            console.log('Execution phase already running, ignoring duplicate start request');
            return;
        }

        if (this.planningTimer) {
            clearInterval(this.planningTimer);
            this.planningTimer = null;
        }

        this.phase = 'executing';
        this.executionStartTime = Date.now();
        
        console.log('Starting execution phase, duration:', GAME_CONFIG.TIMELINE_DURATION, 'seconds');
        
        // Execute timeline-based commands
        const executionDuration = GAME_CONFIG.TIMELINE_DURATION * 1000; // Convert to milliseconds
        const executionInterval = 50; // 20 FPS
        let lastElapsed = 0;

        this.executionTimer = setInterval(() => {
            const elapsed = Date.now() - this.executionStartTime;
            const currentTime = elapsed / 1000; // Convert to seconds
            const deltaTime = (elapsed - lastElapsed) / 1000;
            lastElapsed = elapsed;

            // Log every second instead of every 50ms to reduce spam
            if (Math.floor(currentTime) !== Math.floor(currentTime - deltaTime)) {
                console.log(`Execution time: ${currentTime.toFixed(2)}s / ${GAME_CONFIG.TIMELINE_DURATION}s`);
            }

            this.units.forEach(unit => {
                if (unit.health > 0) {
                    unit.updateExecution(this, currentTime, deltaTime);
                }
            });

            // Remove dead units
            this.units = this.units.filter(unit => unit.health > 0);
            
            // Check if execution phase should end
            if (elapsed >= executionDuration) {
                console.log('Execution phase ending - time limit reached');
                clearInterval(this.executionTimer);
                this.executionTimer = null;
                
                // Ensure phase is set to something other than executing to prevent restart
                this.phase = 'transitioning';
                
                // Reset all units to their final positions and clear execution state
                this.units.forEach(unit => {
                    // Finish any current command
                    if (unit.currentCommand) {
                        console.log(`Force finishing command ${unit.currentCommand.type} for unit ${unit.id.substring(0, 8)} at execution end`);
                        unit.finishCommand(unit.currentCommand, this);
                        unit.currentCommand.executed = true;
                    }
                    
                    // Clear execution state
                    unit.currentCommand = null;
                    unit.commandStartTime = null;
                    unit.isMoving = false;
                    unit.isWatching = false;
                    unit.watchData = null;
                    unit.moveProgress = 0;
                    
                    // Mark all remaining commands as executed to prevent issues in next round
                    if (unit.commandChain) {
                        unit.commandChain.forEach(cmd => {
                            if (!cmd.executed) {
                                console.log(`Marking unfinished command ${cmd.type} as executed for unit ${unit.id.substring(0, 8)}`);
                                cmd.executed = true;
                            }
                        });
                    }
                });
                
                // Check win condition
                if (this.checkWinCondition()) {
                    this.endGame();
                } else {
                    this.startPlanningPhase();
                }
                return;
            }

            // Check for collisions
            const positionMap = new Map();
            this.units.forEach(unit => {
                if (unit.health > 0) {
                    const key = `${unit.gridX},${unit.gridY}`;
                    if (!positionMap.has(key)) positionMap.set(key, []);
                    positionMap.get(key).push(unit);
                }
            });
            
            const collisions = [];
            positionMap.forEach(unitsInCell => {
                if (unitsInCell.length > 1) {
                    unitsInCell.forEach(unit => {
                        const collisionDamage = Math.floor(unit.maxHealth * 0.3);
                        unit.takeDamage(collisionDamage);
                        collisions.push({ unitId: unit.id, amount: collisionDamage });
                    });
                }
            });
            
            // Broadcast game state with execution progress
            this.broadcastGameState({ 
                executionTime: currentTime,
                maxExecutionTime: GAME_CONFIG.TIMELINE_DURATION,
                collisions,
                shootingEffects: this.shootingEffects || []
            });
            
            // Clear shooting effects after broadcasting
            this.shootingEffects = [];
        }, executionInterval);
    }

    checkWinCondition() {
        const playersWithUnits = new Set();
        this.units.forEach(unit => {
            if (unit.health > 0) {
                playersWithUnits.add(unit.playerId);
            }
        });

        return playersWithUnits.size <= 1;
    }

    endGame() {
        this.phase = 'ended';
        const winner = this.units.length > 0 ? this.units[0].playerId : null;
        this.broadcastGameState({ winner });
    }

    getUnitById(id) {
        return this.units.find(unit => unit.id === id);
    }

    getVisibleUnitsForPlayer(playerId) {
        const playerUnits = this.units.filter(u => u.playerId === playerId && u.health > 0);
        const visibleUnits = new Set();
        
        // Add all friendly units
        playerUnits.forEach(unit => visibleUnits.add(unit.id));
        
        // Add enemy units that are visible to any friendly unit
        this.units.forEach(enemyUnit => {
            if (enemyUnit.playerId !== playerId && enemyUnit.health > 0) {
                for (const friendlyUnit of playerUnits) {
                    if (friendlyUnit.canSee(enemyUnit)) {
                        visibleUnits.add(enemyUnit.id);
                        break;
                    }
                }
            }
        });
        
        return this.units.filter(unit => visibleUnits.has(unit.id));
    }

    broadcastGameState(extra = {}) {
        this.players.forEach(player => {
            const socket = io.sockets.sockets.get(player.socketId);
            if (socket) {
                const visibleUnits = this.getVisibleUnitsForPlayer(player.id);
                
                // Hide enemy planning information
                const sanitizedUnits = visibleUnits.map(unit => {
                    if (unit.playerId !== player.id && this.phase === 'planning') {
                        // Hide enemy planned actions during planning phase
                        return {
                            ...unit,
                            commandChain: []
                        };
                    }
                    return unit;
                });

                const gameState = {
                    phase: this.phase,
                    planningTimeLeft: this.planningTimeLeft,
                    units: sanitizedUnits,
                    players: this.players,
                    obstacles: Array.from(this.obstacles).map(obs => {
                        const [x, y] = obs.split(',').map(Number);
                        return { gridX: x, gridY: y };
                    }),
                    ...extra
                };

                socket.emit('gameState', gameState);
            }
        });
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        this.units = this.units.filter(u => u.playerId !== playerId);
        
        if (this.players.length === 0) {
            // Clean up timers
            if (this.planningTimer) clearInterval(this.planningTimer);
            if (this.executionTimer) clearInterval(this.executionTimer);
        }
    }

    startExecution() {
        this.phase = 'execution';
        this.executionStartTime = Date.now();
        
        console.log('Execution phase started');
        this.broadcastGameState();
        
        // Execute all commands over the timeline duration
        setTimeout(() => {
            this.endExecution();
        }, GAME_CONFIG.TIMELINE_DURATION * 1000); // Convert to milliseconds
    }
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinGame', (data) => {
        const playerId = data.playerId || uuidv4();
        const username = data.username || 'Anonymous';
        
        // Add player to matchmaking queue
        addToMatchmakingQueue(playerId, username, socket.id);
    });

    socket.on('planMove', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                const targetGrid = worldToGrid(data.x, data.y);
                const success = unit.planMove(targetGrid.x, targetGrid.y, game.obstacles, game);
                
                if (success) {
                    game.broadcastGameState();
                } else {
                    // Send error message to client
                    socket.emit('commandError', { 
                        message: 'Cannot add command: Timeline limit exceeded',
                        type: 'timeline_full'
                    });
                }
            }
        }
    });

    socket.on('planWait', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                const success = unit.planWait(data.duration || 1);
                
                if (success) {
                    game.broadcastGameState();
                } else {
                    socket.emit('commandError', { 
                        message: 'Cannot add wait: Timeline limit exceeded',
                        type: 'timeline_full'
                    });
                }
            }
        }
    });

    socket.on('planWatchSector', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                const success = unit.planWatchSector(data.gridX, data.gridY, data.direction, data.angle, data.duration);
                
                if (success) {
                    game.broadcastGameState();
                } else {
                    socket.emit('commandError', { 
                        message: 'Cannot add watchSector: Timeline limit exceeded',
                        type: 'timeline_full'
                    });
                }
            }
        }
    });

    socket.on('removeCommand', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                unit.removeCommand(data.commandIndex);
                game.broadcastGameState();
            }
        }
    });

    socket.on('insertCommand', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                unit.insertCommand(data.index, data.commandType, data.commandData);
                game.broadcastGameState();
            }
        }
    });

    socket.on('setReady', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            game.setPlayerReady(playerId, data.ready);
        }
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const playerId = players.get(socket.id);
        
        // Remove from matchmaking queue if they were waiting
        removeFromMatchmakingQueue(socket.id);
        
        if (playerId) {
            const game = Array.from(games.values()).find(g => 
                g.players.some(p => p.id === playerId)
            );

            if (game) {
                game.removePlayer(playerId);
                if (game.players.length === 0) {
                    games.delete(game.id);
                }
            }

            players.delete(socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to play the game`);
}); 