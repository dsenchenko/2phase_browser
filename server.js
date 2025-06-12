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

// Game constants
const GAME_CONFIG = {
    PLANNING_TIME: 60000, // 1 minute in milliseconds
    MAP_WIDTH: 800,
    MAP_HEIGHT: 600,
    GRID_SIZE: 40,
    UNIT_SIZE: 20,
    MAX_PLAYERS: 2,
    VISION_RANGE: 4, // cells
    TIMELINE_DURATION: 20, // seconds for execution phase
    TIME_PER_MOVE: 1, // seconds per grid cell movement
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
        this.range = 2; // grid cells
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

    planMove(targetGridX, targetGridY, obstacles) {
        const start = this.getLastCommandEndPosition();
        const end = { x: targetGridX, y: targetGridY };
        
        const path = findPath(start, end, obstacles);
        if (path.length > 1) {
            const command = this.addCommand('move', { path: path });
            return command !== null; // Return success/failure
        }
        return false;
    }

    planAttack(targetId) {
        const command = this.addCommand('attack', { targetId: targetId });
        return command !== null; // Return success/failure
    }

    planWait(duration) {
        const command = this.addCommand('wait', { duration: duration });
        return command !== null; // Return success/failure
    }

    updateExecution(game, currentTime, deltaTime) {
        // Start new command if needed
        if (!this.currentCommand) {
            const nextCommand = this.commandChain.find(cmd => 
                !cmd.executed && cmd.startTime <= currentTime
            );
            
            if (nextCommand) {
                this.currentCommand = nextCommand;
                this.commandStartTime = currentTime;
                this.startCommand(nextCommand, game);
            }
        }
        
        // Update current command
        if (this.currentCommand) {
            const commandProgress = (currentTime - this.commandStartTime) / this.currentCommand.duration;
            
            if (commandProgress >= 1.0) {
                // Command finished
                this.finishCommand(this.currentCommand, game);
                this.currentCommand.executed = true;
                this.currentCommand = null;
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
                    // Start from current actual position (which should be where previous command ended)
                    this.moveStartGrid = { x: this.gridX, y: this.gridY };
                    this.moveTargetGrid = command.data.path[command.data.path.length - 1];
                    this.moveProgress = 0;
                    
                    // If the path starts from a different position than current, 
                    // we need to adjust the path or current position
                    if (command.data.path[0].x !== this.gridX || command.data.path[0].y !== this.gridY) {
                        // Update current position to match path start
                        this.gridX = command.data.path[0].x;
                        this.gridY = command.data.path[0].y;
                        const worldPos = gridToWorld(this.gridX, this.gridY);
                        this.x = worldPos.x;
                        this.y = worldPos.y;
                        this.moveStartGrid = { x: this.gridX, y: this.gridY };
                    }
                }
                break;
            case 'attack':
                // Attack starts immediately but takes time to complete
                break;
            case 'wait':
                // Nothing to start for wait
                break;
        }
    }

    updateCommand(command, progress, game, deltaTime) {
        switch (command.type) {
            case 'move':
                if (this.isMoving && command.data.path) {
                    // Smooth movement along path
                    const totalSteps = command.data.path.length - 1;
                    const currentStep = Math.floor(progress * totalSteps);
                    const stepProgress = (progress * totalSteps) - currentStep;
                    
                    if (currentStep < command.data.path.length - 1) {
                        const from = command.data.path[currentStep];
                        const to = command.data.path[currentStep + 1];
                        
                        const fromWorld = gridToWorld(from.x, from.y);
                        const toWorld = gridToWorld(to.x, to.y);
                        
                        this.x = fromWorld.x + (toWorld.x - fromWorld.x) * stepProgress;
                        this.y = fromWorld.y + (toWorld.y - fromWorld.y) * stepProgress;
                        
                        // Update grid position when crossing cell boundaries
                        if (stepProgress > 0.5) {
                            this.gridX = to.x;
                            this.gridY = to.y;
                        } else {
                            this.gridX = from.x;
                            this.gridY = from.y;
                        }
                    }
                }
                break;
        }
    }

    finishCommand(command, game) {
        switch (command.type) {
            case 'move':
                if (command.data.path && command.data.path.length > 0) {
                    const finalPos = command.data.path[command.data.path.length - 1];
                    this.gridX = finalPos.x;
                    this.gridY = finalPos.y;
                    const worldPos = gridToWorld(this.gridX, this.gridY);
                    this.x = worldPos.x;
                    this.y = worldPos.y;
                }
                this.isMoving = false;
                break;
            case 'attack':
                const target = game.getUnitById(command.data.targetId);
                if (target && this.canAttack(target)) {
                    target.takeDamage(this.damage);
                }
                break;
            case 'wait':
                // Nothing to finish for wait
                break;
        }
    }

    canAttack(target) {
        const distance = getGridDistance(
            { x: this.gridX, y: this.gridY },
            { x: target.gridX, y: target.gridY }
        );
        return distance <= this.range && target.playerId !== this.playerId;
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
        
        // Generate random obstacles (about 15% of the map)
        const obstacleCount = Math.floor(gridWidth * gridHeight * 0.15);
        
        for (let i = 0; i < obstacleCount; i++) {
            let x, y;
            do {
                x = Math.floor(Math.random() * gridWidth);
                y = Math.floor(Math.random() * gridHeight);
            } while (
                this.obstacles.has(`${x},${y}`) ||
                (x < 3 && y >= gridHeight / 2 - 2 && y <= gridHeight / 2 + 2) || // Player 1 spawn area
                (x >= gridWidth - 3 && y >= gridHeight / 2 - 2 && y <= gridHeight / 2 + 2) // Player 2 spawn area
            );
            
            this.obstacles.add(`${x},${y}`);
        }
    }

    addPlayer(playerId, socketId) {
        if (this.players.length >= GAME_CONFIG.MAX_PLAYERS) {
            return false;
        }

        const player = {
            id: playerId,
            socketId: socketId,
            ready: false,
            planningReady: false,
            color: this.players.length === 0 ? '#4CAF50' : '#F44336'
        };

        this.players.push(player);
        this.spawnUnitsForPlayer(playerId);

        if (this.players.length === GAME_CONFIG.MAX_PLAYERS) {
            this.startPlanningPhase();
        }

        return true;
    }

    spawnUnitsForPlayer(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        const gridWidth = Math.ceil(GAME_CONFIG.MAP_WIDTH / GAME_CONFIG.GRID_SIZE);
        const gridHeight = Math.ceil(GAME_CONFIG.MAP_HEIGHT / GAME_CONFIG.GRID_SIZE);
        
        const startGridX = playerIndex === 0 ? 1 : gridWidth - 2;
        const centerGridY = Math.floor(gridHeight / 2);

        // Spawn 3 units for each player
        for (let i = 0; i < 3; i++) {
            const unit = new Unit(
                uuidv4(),
                startGridX,
                centerGridY + (i - 1),
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
            
            if (this.planningTimeLeft <= 0) {
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
        if (this.planningTimer) {
            clearInterval(this.planningTimer);
            this.planningTimer = null;
        }

        this.phase = 'executing';
        this.executionStartTime = Date.now();
        
        // Execute timeline-based commands
        const executionDuration = GAME_CONFIG.TIMELINE_DURATION * 1000; // Convert to milliseconds
        const executionInterval = 50; // 20 FPS
        let lastTime = 0;

        this.executionTimer = setInterval(() => {
            const elapsed = Date.now() - this.executionStartTime;
            const currentTime = elapsed / 1000; // Convert to seconds
            const deltaTime = (elapsed - lastTime) / 1000;
            lastTime = elapsed;

            this.units.forEach(unit => {
                if (unit.health > 0) {
                    unit.updateExecution(this, currentTime, deltaTime);
                }
            });

            // Remove dead units
            this.units = this.units.filter(unit => unit.health > 0);
            
            if (elapsed >= executionDuration) {
                clearInterval(this.executionTimer);
                this.executionTimer = null;
                
                // Check win condition
                if (this.checkWinCondition()) {
                    this.endGame();
                } else {
                    this.startPlanningPhase();
                }
            }

            this.broadcastGameState({ 
                executionTime: currentTime,
                maxExecutionTime: GAME_CONFIG.TIMELINE_DURATION 
            });
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
        players.set(socket.id, playerId);

        // Find or create a game
        let game = Array.from(games.values()).find(g => 
            g.players.length < GAME_CONFIG.MAX_PLAYERS && g.phase === 'waiting'
        );

        if (!game) {
            const gameId = uuidv4();
            game = new Game(gameId);
            games.set(gameId, game);
        }

        if (game.addPlayer(playerId, socket.id)) {
            socket.join(game.id);
            socket.emit('joined', { 
                playerId, 
                gameId: game.id,
                playerColor: game.players.find(p => p.id === playerId).color
            });
            game.broadcastGameState();
        } else {
            socket.emit('error', { message: 'Game is full' });
        }
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
                const success = unit.planMove(targetGrid.x, targetGrid.y, game.obstacles);
                
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

    socket.on('planAttack', (data) => {
        const playerId = players.get(socket.id);
        const game = Array.from(games.values()).find(g => 
            g.players.some(p => p.id === playerId)
        );

        if (game && game.phase === 'planning') {
            const unit = game.getUnitById(data.unitId);
            if (unit && unit.playerId === playerId) {
                const success = unit.planAttack(data.targetId);
                
                if (success) {
                    game.broadcastGameState();
                } else {
                    socket.emit('commandError', { 
                        message: 'Cannot add attack: Timeline limit exceeded',
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