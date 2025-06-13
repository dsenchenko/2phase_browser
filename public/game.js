class GameClient {
    constructor(username) {
        this.socket = io();
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.playerId = null;
        this.playerColor = '#4CAF50';
        this.username = username;
        this.gameState = null;
        this.selectedUnit = null;
        this.isReady = false;
        this.particles = [];
        this.damagePopups = [];
        
        // Sector selection state
        this.sectorSelectionMode = false;
        this.sectorGridX = null;
        this.sectorGridY = null;
        this.sectorDirection = 0; // radians
        this.sectorAngle = Math.PI / 3; // 60 degrees cone
        
        this.setupEventListeners();
        this.setupSocketListeners();
        this.joinGame();
        
        // Start render loop
        this.render();
        
        // Update game URL
        document.getElementById('gameUrl').textContent = window.location.href;
    }

    setupEventListeners() {
        this.canvas.addEventListener('click', (e) => this.handleCanvasClick(e));
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.handleCanvasRightClick(e);
        });
        this.canvas.addEventListener('mousemove', (e) => this.handleCanvasMouseMove(e));

        // Ready button event listener
        document.getElementById('readyButton').addEventListener('click', () => {
            this.toggleReady();
        });

        // Timeline control event listeners
        this.setupWaitButton();

        document.getElementById('clearCommandsButton').addEventListener('click', () => {
            if (this.selectedUnit) {
                // Clear all commands by removing them one by one
                for (let i = this.selectedUnit.commandChain.length - 1; i >= 0; i--) {
                    this.socket.emit('removeCommand', {
                        unitId: this.selectedUnit.id,
                        commandIndex: i
                    });
                }
            }
        });

        // Add keyboard listener for ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.sectorSelectionMode) {
                this.cancelSectorSelection();
            }
        });
    }

    setupSocketListeners() {
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.updateConnectionStatus(true);
        });

        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.updateConnectionStatus(false);
        });

        this.socket.on('joined', (data) => {
            this.playerId = data.playerId;
            this.playerColor = data.playerColor;
            console.log('Joined game as player:', this.playerId);
        });

        this.socket.on('matchmakingUpdate', (data) => {
            this.updateMatchmakingUI(data);
        });

        this.socket.on('gameStarted', (data) => {
            console.log('Game started with', data.playerCount, 'players');
            document.getElementById('waitingArea').style.display = 'none';
            document.getElementById('gameArea').style.display = 'block';
        });

        this.socket.on('gameState', (gameState) => {
            this.gameState = gameState;
            this.updateUI();
            if (gameState.phase === 'executing' && gameState.units) {
                this.spawnAttackParticles(gameState);
            }
            if (gameState.collisions && Array.isArray(gameState.collisions)) {
                gameState.collisions.forEach(collision => {
                    const unit = gameState.units.find(u => u.id === collision.unitId);
                    if (unit) {
                        this.damagePopups.push({
                            x: unit.x,
                            y: unit.y - 30,
                            amount: collision.amount,
                            alpha: 1,
                            vy: -0.5,
                            time: 0
                        });
                    }
                });
            }
            if (gameState.shootingEffects && Array.isArray(gameState.shootingEffects)) {
                gameState.shootingEffects.forEach(effect => {
                    this.particles.push({
                        from: { x: effect.from.x, y: effect.from.y },
                        to: { x: effect.to.x, y: effect.to.y },
                        color: '#FFD700',
                        progress: 0,
                        speed: 1 / 30, // Fast bullet effect (0.5s duration at 60fps)
                        unitId: 'shooting',
                        targetId: 'effect',
                        commandStart: Date.now()
                    });
                });
            }
        });

        this.socket.on('commandError', (error) => {
            this.showCommandError(error.message);
        });

        this.socket.on('error', (error) => {
            alert('Error: ' + error.message);
        });
    }

    updateConnectionStatus(connected) {
        const status = document.getElementById('connectionStatus');
        status.textContent = connected ? 'Connected' : 'Disconnected';
        status.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
    }

    joinGame() {
        this.socket.emit('joinGame', { 
            playerId: this.playerId,
            username: this.username 
        });
    }

    handleCanvasMouseMove(e) {
        if (this.sectorSelectionMode) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            // Update cone direction based on mouse position
            const sectorWorldX = this.sectorGridX * 40 + 20;
            const sectorWorldY = this.sectorGridY * 40 + 20;
            this.sectorDirection = Math.atan2(mouseY - sectorWorldY, mouseX - sectorWorldX);
        }
    }

    handleCanvasClick(e) {
        if (this.sectorSelectionMode) {
            // Handle sector confirmation
            const durationSelect = document.getElementById('durationSelect');
            const duration = durationSelect ? parseInt(durationSelect.value) : 5;
            this.confirmSectorSelection(duration);
            return;
        }

        if (!this.gameState || this.gameState.phase !== 'planning') return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if clicking on a unit
        const clickedUnit = this.getUnitAtPosition(x, y);
        
        if (clickedUnit && clickedUnit.playerId === this.playerId) {
            // Select own unit
            this.selectUnit(clickedUnit);
        } else if (this.selectedUnit) {
            // Snap to grid for movement
            const gridSize = 40;
            const gridX = Math.floor(x / gridSize);
            const gridY = Math.floor(y / gridSize);
            const snapX = gridX * gridSize + gridSize / 2;
            const snapY = gridY * gridSize + gridSize / 2;
            
            // Check if target position is not an obstacle
            const isObstacle = this.gameState.obstacles && 
                this.gameState.obstacles.some(obs => obs.gridX === gridX && obs.gridY === gridY);
            
            if (!isObstacle) {
                // Estimate path length for validation
                const currentPos = this.selectedUnit.getLastCommandEndPosition ? 
                    this.selectedUnit.getLastCommandEndPosition() : 
                    { x: this.selectedUnit.gridX, y: this.selectedUnit.gridY };
                
                const pathLength = Math.abs(gridX - currentPos.x) + Math.abs(gridY - currentPos.y);
                
                if (this.canAddSpecificCommand('move', { pathLength })) {
                    this.socket.emit('planMove', {
                        unitId: this.selectedUnit.id,
                        x: snapX,
                        y: snapY
                    });
                } else {
                    this.showCommandError('Cannot add move: Would exceed 20s timeline limit');
                }
            }
        }
    }

    handleCanvasRightClick(e) {
        if (!this.gameState || this.gameState.phase !== 'planning' || !this.selectedUnit) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Check if clicking on empty cell (not on a unit)
        const targetUnit = this.getUnitAtPosition(x, y);
        
        if (!targetUnit) {
            // Right-click on empty cell - start sector selection
            const gridSize = 40;
            const gridX = Math.floor(x / gridSize);
            const gridY = Math.floor(y / gridSize);
            
            // Check if target position is not an obstacle
            const isObstacle = this.gameState.obstacles && 
                this.gameState.obstacles.some(obs => obs.gridX === gridX && obs.gridY === gridY);
            
            if (!isObstacle) {
                this.startVisualSectorSelection(gridX, gridY, x, y);
            }
        }
    }

    getUnitAtPosition(x, y) {
        if (!this.gameState) return null;

        return this.gameState.units.find(unit => {
            const dx = unit.x - x;
            const dy = unit.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            return distance <= 15; // Unit click radius
        });
    }

    selectUnit(unit) {
        // Deselect all units first
        if (this.gameState) {
            this.gameState.units.forEach(u => u.selected = false);
        }
        
        this.selectedUnit = unit;
        unit.selected = true;
        
        document.getElementById('selectedUnit').textContent = 
            `Selected: Unit ${unit.id.substring(0, 8)}... (HP: ${unit.health}/${unit.maxHealth})`;
    }

    updateUI() {
        if (!this.gameState) return;

        // Show/hide game areas
        const gameArea = document.getElementById('gameArea');
        const waitingArea = document.getElementById('waitingArea');
        
        if (this.gameState.players.length >= 2) {
            gameArea.style.display = 'block';
            waitingArea.style.display = 'none';
        } else {
            gameArea.style.display = 'none';
            waitingArea.style.display = 'block';
        }

        // Update phase indicator
        const phaseIndicator = document.getElementById('phaseIndicator');
        const phase = this.gameState.phase;
        
        phaseIndicator.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
        phaseIndicator.className = 'phase-indicator ' + phase;

        // Update timer
        const timer = document.getElementById('timer');
        if (phase === 'planning') {
            const minutes = Math.floor(this.gameState.planningTimeLeft / 60000);
            const seconds = Math.floor((this.gameState.planningTimeLeft % 60000) / 1000);
            timer.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        } else {
            timer.textContent = '--:--';
        }

        // Update player info
        const playerInfo = document.getElementById('playerInfo');
        const playerIndex = this.gameState.players.findIndex(p => p.id === this.playerId);
        playerInfo.textContent = `Player ${playerIndex + 1}`;
        playerInfo.style.color = this.playerColor;

        // Update ready controls
        this.updateReadyControls();

        // Update timeline display
        this.updateTimeline();

        // Handle game end
        if (this.gameState.winner) {
            const isWinner = this.gameState.winner === this.playerId;
            setTimeout(() => {
                alert(isWinner ? '🎉 You Won!' : '💀 You Lost!');
            }, 100);
        }
    }

    updateReadyControls() {
        const readyControls = document.getElementById('readyControls');
        const readyButton = document.getElementById('readyButton');
        const readyButtonText = document.getElementById('readyButtonText');
        const readyStatus = document.getElementById('readyStatus');

        if (this.gameState.phase === 'planning') {
            readyControls.style.display = 'block';
            
            // Update current player's ready state
            const currentPlayer = this.gameState.players.find(p => p.id === this.playerId);
            this.isReady = currentPlayer ? currentPlayer.planningReady : false;
            
            // Update button appearance
            if (this.isReady) {
                readyButton.className = 'ready-button ready';
                readyButtonText.textContent = 'Cancel Ready';
            } else {
                readyButton.className = 'ready-button not-ready';
                readyButtonText.textContent = 'Ready';
            }
            
            readyButton.disabled = false;
            
            // Update ready status display
            const readyPlayers = this.gameState.players.filter(p => p.planningReady);
            const totalPlayers = this.gameState.players.length;
            
            let statusText = `Ready: ${readyPlayers.length}/${totalPlayers}`;
            if (readyPlayers.length === totalPlayers && totalPlayers > 1) {
                statusText += ' - Starting execution...';
                readyStatus.className = 'player-ready';
            } else {
                readyStatus.className = 'player-not-ready';
            }
            
            // Show individual player status
            const playerStatuses = this.gameState.players.map((player, index) => {
                const status = player.planningReady ? '✓' : '⏳';
                const className = player.planningReady ? 'player-ready' : 'player-not-ready';
                return `<span class="${className}">Player ${index + 1}: ${status}</span>`;
            }).join(' | ');
            
            readyStatus.innerHTML = `${statusText}<br/>${playerStatuses}`;
            
        } else {
            readyControls.style.display = 'none';
        }
    }

    updateTimeline() {
        const timelineContainer = document.getElementById('timelineContainer');
        const timelineControls = document.getElementById('timelineControls');
        const timelineScale = document.getElementById('timelineScale');
        const timelineUnits = document.getElementById('timelineUnits');
        const timelineInfo = document.getElementById('timelineInfo');
        
        if (this.gameState && this.gameState.phase === 'planning') {
            timelineControls.style.display = 'block';
            
            const maxTime = 20; // 20 second timeline
            const timelineWidth = 600; // pixels (wider for 20s)
            
            // Update time scale
            this.updateTimelineScale(timelineScale, maxTime, timelineWidth);
            
            // Update unit rows
            this.updateUnitRows(timelineUnits, maxTime, timelineWidth);
            
            // Update timeline info
            if (this.selectedUnit) {
                const totalTime = this.selectedUnit.getTotalTimelineLength ? this.selectedUnit.getTotalTimelineLength() : 0;
                const timeLeft = maxTime - totalTime;
                const canAddCommands = timeLeft > 0;
                
                timelineInfo.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span>Selected: ${this.selectedUnit.id.substring(0, 8)}...</span>
                        <span style="color: ${canAddCommands ? '#4CAF50' : '#F44336'}">
                            Time: ${totalTime.toFixed(1)}s / ${maxTime}s 
                            ${canAddCommands ? `(${timeLeft.toFixed(1)}s left)` : '(TIMELINE FULL)'}
                        </span>
                    </div>
                    <div style="font-size: 0.8em; color: #aaa; margin-top: 5px;">
                        Movement: 0.5s per cell | Attack: 5s | Wait: 1s
                    </div>
                `;
                
                // Disable command buttons if timeline is full
                document.getElementById('waitButton').disabled = !canAddCommands;
                this.canvas.style.cursor = canAddCommands ? 'crosshair' : 'not-allowed';
            } else {
                timelineInfo.innerHTML = '<div style="text-align: center; color: #888;">Select a unit to view its timeline</div>';
            }
        } else {
            timelineControls.style.display = 'none';
        }
    }

    updateTimelineScale(scaleElement, maxTime, timelineWidth) {
        scaleElement.innerHTML = '';
        
        // Create time ruler
        const ruler = document.createElement('div');
        ruler.style.cssText = `
            position: relative;
            height: 30px;
            border-bottom: 2px solid #333;
            margin-bottom: 10px;
        `;
        
        // Add time markers every 2 seconds for 20s timeline
        for (let t = 0; t <= maxTime; t += 2) {
            const marker = document.createElement('div');
            const position = (t / maxTime) * timelineWidth;
            
            marker.style.cssText = `
                position: absolute;
                left: ${position}px;
                top: 0;
                width: 2px;
                height: 20px;
                background: #666;
                transform: translateX(-1px);
            `;
            
            const label = document.createElement('div');
            label.style.cssText = `
                position: absolute;
                left: ${position}px;
                top: 22px;
                font-size: 10px;
                color: #aaa;
                transform: translateX(-50%);
                white-space: nowrap;
            `;
            label.textContent = `${t}s`;
            
            ruler.appendChild(marker);
            ruler.appendChild(label);
        }
        
        scaleElement.appendChild(ruler);
    }

    updateUnitRows(unitsElement, maxTime, width) {
        if (!this.gameState || !this.gameState.units) return;
        
        const myUnits = this.gameState.units.filter(unit => unit.playerId === this.playerId);
        let unitsHTML = '';
        
        myUnits.forEach(unit => {
            const isSelected = this.selectedUnit && this.selectedUnit.id === unit.id;
            const totalTime = unit.getTotalTimelineLength ? unit.getTotalTimelineLength() : 0;
            const isOverflow = totalTime > maxTime;
            
            unitsHTML += `
                <div class="timeline-unit-row ${isSelected ? 'selected' : ''}" 
                     onclick="gameClient.selectUnitFromTimeline('${unit.id}')">
                    <div class="timeline-unit-info">
                        <div class="timeline-unit-name">${unit.id.substring(0, 8)}...</div>
                        <div class="timeline-unit-health">HP: ${unit.health}/${unit.maxHealth}</div>
                    </div>
                    <div class="timeline-track ${isOverflow ? 'timeline-overflow-warning' : ''}" style="width: ${width}px;">
                        ${this.renderUnitCommands(unit, maxTime, width)}
                        ${this.gameState.executionTime !== undefined ? this.renderExecutionProgress(maxTime, width) : ''}
                    </div>
                </div>
            `;
        });
        
        unitsElement.innerHTML = unitsHTML;
    }

    renderUnitCommands(unit, maxTime, width) {
        if (!unit.commandChain) return '';
        
        let commandsHTML = '';
        
        unit.commandChain.forEach((command, index) => {
            const startPercent = (command.startTime / maxTime) * 100;
            const widthPercent = (command.duration / maxTime) * 100;
            const left = (command.startTime / maxTime) * width;
            const commandWidth = (command.duration / maxTime) * width;
            
            let commandText = '';
            let commandClass = command.type;
            
            switch (command.type) {
                case 'move':
                    const pathLength = command.data.path ? command.data.path.length - 1 : 0;
                    commandText = `Move ${pathLength}`;
                    break;
                case 'attack':
                    commandText = 'Attack';
                    break;
                case 'wait':
                    commandText = `Wait ${command.duration}s`;
                    break;
                case 'watchSector':
                    commandText = `Watch Sector ${index + 1}`;
                    break;
            }
            
            commandsHTML += `
                <div class="timeline-command-block ${commandClass}" 
                     style="left: ${left}px; width: ${commandWidth}px;"
                     onclick="gameClient.removeCommand(${index})"
                     title="Click to remove: ${commandText} (${command.startTime.toFixed(1)}s - ${command.endTime.toFixed(1)}s)">
                    ${commandText}
                </div>
            `;
        });
        
        return commandsHTML;
    }

    renderExecutionProgress(maxTime, width) {
        const progressPercent = (this.gameState.executionTime / this.gameState.maxExecutionTime) * 100;
        const progressWidth = (this.gameState.executionTime / maxTime) * width;
        
        return `<div class="timeline-progress-overlay" style="width: ${progressWidth}px;"></div>`;
    }

    selectUnitFromTimeline(unitId) {
        if (this.gameState && this.gameState.phase === 'planning') {
            const unit = this.gameState.units.find(u => u.id === unitId);
            if (unit && unit.playerId === this.playerId) {
                this.selectUnit(unit);
            }
        }
    }

    canAddCommand() {
        if (!this.selectedUnit || !this.gameState || this.gameState.phase !== 'planning') {
            return false;
        }
        
        const totalTime = this.selectedUnit.getTotalTimelineLength ? this.selectedUnit.getTotalTimelineLength() : 0;
        return totalTime < 20; // 20 second limit
    }

    removeCommand(index) {
        if (this.selectedUnit && this.gameState.phase === 'planning') {
            this.socket.emit('removeCommand', {
                unitId: this.selectedUnit.id,
                commandIndex: index
            });
        }
    }

    toggleReady() {
        if (this.gameState && this.gameState.phase === 'planning') {
            this.socket.emit('setReady', { ready: !this.isReady });
        }
    }

    render() {
        this.clearCanvas();
        
        if (this.gameState && this.gameState.units) {
            this.drawUnits();
            this.drawPlannedActions();
        }
        
        // Draw sector selection preview
        if (this.sectorSelectionMode) {
            this.drawSectorPreview();
        }
        
        // Only draw particles and damage popups during execution phase
        if (this.gameState && this.gameState.phase === 'executing') {
            this.updateAndDrawParticles();
            this.updateAndDrawDamagePopups();
        }
        
        requestAnimationFrame(() => this.render());
    }

    clearCanvas() {
        this.ctx.fillStyle = '#2d5a27';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw grid
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.ctx.lineWidth = 1;
        
        const gridSize = 40;
        for (let x = 0; x < this.canvas.width; x += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
            this.ctx.stroke();
        }
        
        for (let y = 0; y < this.canvas.height; y += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }
        
        // Draw obstacles
        if (this.gameState && this.gameState.obstacles) {
            this.ctx.fillStyle = '#8B4513';
            this.gameState.obstacles.forEach(obstacle => {
                const x = obstacle.gridX * gridSize;
                const y = obstacle.gridY * gridSize;
                this.ctx.fillRect(x, y, gridSize, gridSize);
                
                // Add some texture to obstacles
                this.ctx.fillStyle = '#654321';
                this.ctx.fillRect(x + 2, y + 2, gridSize - 4, gridSize - 4);
                this.ctx.fillStyle = '#8B4513';
            });
        }
    }

    drawUnits() {
        this.gameState.units.forEach(unit => {
            const player = this.gameState.players.find(p => p.id === unit.playerId);
            const color = player ? player.color : '#888';
            const isMyUnit = unit.playerId === this.playerId;
            
            // Draw vision range for selected friendly units
            if (unit.selected && isMyUnit) {
                this.ctx.fillStyle = 'rgba(255, 255, 0, 0.1)';
                this.ctx.beginPath();
                this.ctx.arc(unit.x, unit.y, unit.visionRange * 40, 0, Math.PI * 2);
                this.ctx.fill();
            }
            
            // Draw unit body
            this.ctx.fillStyle = color;
            this.ctx.beginPath();
            this.ctx.arc(unit.x, unit.y, 15, 0, Math.PI * 2);
            this.ctx.fill();
            
            // Add border for better visibility
            this.ctx.strokeStyle = isMyUnit ? '#FFFFFF' : '#000000';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
            
            // Draw selection indicator
            if (unit.selected) {
                this.ctx.strokeStyle = '#FFD700';
                this.ctx.lineWidth = 3;
                this.ctx.beginPath();
                this.ctx.arc(unit.x, unit.y, 18, 0, Math.PI * 2);
                this.ctx.stroke();
            }
            
            // Draw health bar
            const barWidth = 30;
            const barHeight = 4;
            const barX = unit.x - barWidth / 2;
            const barY = unit.y - 25;
            
            // Background
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            this.ctx.fillRect(barX, barY, barWidth, barHeight);
            
            // Health
            const healthPercent = unit.health / unit.maxHealth;
            this.ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : 
                               healthPercent > 0.25 ? '#FF9800' : '#F44336';
            this.ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
            
            // Unit ID (short)
            this.ctx.fillStyle = 'white';
            this.ctx.font = '10px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(unit.id.substring(0, 3), unit.x, unit.y + 4);
            
            // Draw fog of war indicator for enemy units
            if (!isMyUnit) {
                this.ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
                this.ctx.font = '12px Arial';
                this.ctx.fillText('👁', unit.x, unit.y - 30);
            }
        });
    }

    drawPlannedActions() {
        if (!this.gameState) return;

        this.gameState.units.forEach(unit => {
            const isMyUnit = unit.playerId === this.playerId;
            const isExecutionPhase = this.gameState.phase === 'executing';
            
            // Draw command chain visualization for own units
            if (unit.commandChain && isMyUnit) {
                // During planning: Track position through command chain
                let currentPos = { x: unit.x, y: unit.y };
                
                unit.commandChain.forEach((command, index) => {
                    switch (command.type) {
                        case 'move':
                            if (command.data.path && command.data.path.length > 1) {
                                // Draw path - transparent during execution, normal during planning
                                this.ctx.strokeStyle = isExecutionPhase ? 'rgba(0, 255, 0, 0.1)' : '#00FF00';
                                this.ctx.lineWidth = 3;
                                this.ctx.setLineDash([8, 4]);
                                
                                this.ctx.beginPath();
                                this.ctx.moveTo(currentPos.x, currentPos.y);
                                
                                // Draw path from current position, skipping the first point if it matches current position
                                let startIndex = 0;
                                if (command.data.path.length > 0) {
                                    const firstPoint = command.data.path[0];
                                    const firstWorldPos = {
                                        x: firstPoint.x * 40 + 20,
                                        y: firstPoint.y * 40 + 20
                                    };
                                    
                                    // If first point is close to current position, skip it
                                    const distance = Math.sqrt(
                                        Math.pow(firstWorldPos.x - currentPos.x, 2) + 
                                        Math.pow(firstWorldPos.y - currentPos.y, 2)
                                    );
                                    
                                    if (distance < 30) { // Close enough to be the same position
                                        startIndex = 1;
                                    }
                                }
                                
                                for (let i = startIndex; i < command.data.path.length; i++) {
                                    const pathPoint = command.data.path[i];
                                    const worldX = pathPoint.x * 40 + 20;
                                    const worldY = pathPoint.y * 40 + 20;
                                    this.ctx.lineTo(worldX, worldY);
                                }
                                
                                this.ctx.stroke();
                                this.ctx.setLineDash([]);
                                
                                // Update current position to end of path
                                const finalPoint = command.data.path[command.data.path.length - 1];
                                currentPos = {
                                    x: finalPoint.x * 40 + 20,
                                    y: finalPoint.y * 40 + 20
                                };
                                
                                // Draw command number at end position - transparent during execution
                                this.ctx.fillStyle = isExecutionPhase ? 'rgba(0, 255, 0, 0.1)' : '#00FF00';
                                this.ctx.font = '12px Arial';
                                this.ctx.textAlign = 'center';
                                this.ctx.fillText((index + 1).toString(), currentPos.x, currentPos.y - 15);
                                
                                // Draw waypoint marker at end - transparent during execution
                                this.ctx.fillStyle = isExecutionPhase ? 'rgba(0, 255, 0, 0.1)' : '#00FF00';
                                this.ctx.beginPath();
                                this.ctx.arc(currentPos.x, currentPos.y, 6, 0, Math.PI * 2);
                                this.ctx.fill();
                            }
                            break;
                        
                        case 'attack':
                            const target = this.gameState.units.find(u => u.id === command.data.targetId);
                            if (target) {
                                this.ctx.strokeStyle = isExecutionPhase ? 'rgba(255, 0, 0, 0.1)' : '#FF0000';
                                this.ctx.lineWidth = 3;
                                this.ctx.setLineDash([3, 3]);
                                
                                this.ctx.beginPath();
                                this.ctx.moveTo(currentPos.x, currentPos.y);
                                this.ctx.lineTo(target.x, target.y);
                                this.ctx.stroke();
                                
                                this.ctx.setLineDash([]);
                                
                                // Draw crosshair on target - transparent during execution
                                this.ctx.strokeStyle = isExecutionPhase ? 'rgba(255, 0, 0, 0.1)' : '#FF0000';
                                this.ctx.lineWidth = 2;
                                this.ctx.beginPath();
                                this.ctx.moveTo(target.x - 10, target.y);
                                this.ctx.lineTo(target.x + 10, target.y);
                                this.ctx.moveTo(target.x, target.y - 10);
                                this.ctx.lineTo(target.x, target.y + 10);
                                this.ctx.stroke();
                                
                                // Draw command number at current position - transparent during execution
                                this.ctx.fillStyle = isExecutionPhase ? 'rgba(255, 0, 0, 0.1)' : '#FF0000';
                                this.ctx.font = '12px Arial';
                                this.ctx.textAlign = 'center';
                                this.ctx.fillText((index + 1).toString(), currentPos.x, currentPos.y - 15);
                            }
                            break;
                            
                        case 'wait':
                            // Draw wait indicator at current position - transparent during execution
                            this.ctx.fillStyle = isExecutionPhase ? 'rgba(255, 152, 0, 0.1)' : '#FF9800';
                            this.ctx.beginPath();
                            this.ctx.arc(currentPos.x, currentPos.y, 8, 0, Math.PI * 2);
                            this.ctx.fill();
                            
                            // Draw command number - transparent during execution
                            this.ctx.fillStyle = isExecutionPhase ? 'rgba(255, 152, 0, 0.1)' : '#FF9800';
                            this.ctx.font = '12px Arial';
                            this.ctx.textAlign = 'center';
                            this.ctx.fillText((index + 1).toString(), currentPos.x, currentPos.y - 15);
                            break;
                            
                        case 'watchSector':
                            const sectorData = command.data;
                            const sectorWorldX = sectorData.gridX * 40 + 20;
                            const sectorWorldY = sectorData.gridY * 40 + 20;
                            
                            this.drawSectorCone(
                                sectorWorldX, 
                                sectorWorldY, 
                                sectorData.direction, 
                                sectorData.angle, 
                                (unit.shootRange || 5) * 40,
                                isExecutionPhase ? 'rgba(255, 165, 0, 0.05)' : 'rgba(255, 165, 0, 0.3)',
                                isExecutionPhase ? 'rgba(255, 165, 0, 0.1)' : 'rgba(255, 165, 0, 0.8)'
                            );
                            
                            // Draw command number at sector position - transparent during execution
                            this.ctx.fillStyle = isExecutionPhase ? 'rgba(255, 152, 0, 0.1)' : '#FF9800';
                            this.ctx.font = '12px Arial';
                            this.ctx.textAlign = 'center';
                            this.ctx.fillText((index + 1).toString(), sectorWorldX, sectorWorldY - 15);
                            
                            // Update current position to sector position
                            currentPos = {
                                x: sectorWorldX,
                                y: sectorWorldY
                            };
                            break;
                    }
                });
            }
        });
    }

    drawSectorCone(centerX, centerY, direction, angle, range, fillColor, strokeColor) {
        this.ctx.save();
        
        // Draw filled cone
        this.ctx.fillStyle = fillColor;
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, centerY);
        
        const startAngle = direction - angle / 2;
        const endAngle = direction + angle / 2;
        const steps = 20;
        
        for (let i = 0; i <= steps; i++) {
            const currentAngle = startAngle + (endAngle - startAngle) * (i / steps);
            const x = centerX + Math.cos(currentAngle) * range;
            const y = centerY + Math.sin(currentAngle) * range;
            this.ctx.lineTo(x, y);
        }
        
        this.ctx.closePath();
        this.ctx.fill();
        
        // Draw cone outline
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = 2;
        this.ctx.stroke();
        
        // Draw direction indicator (center line)
        this.ctx.strokeStyle = strokeColor;
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(centerX, centerY);
        this.ctx.lineTo(
            centerX + Math.cos(direction) * range,
            centerY + Math.sin(direction) * range
        );
        this.ctx.stroke();
        
        this.ctx.restore();
    }

    showCommandError(message) {
        // Create a temporary error message
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(244, 67, 54, 0.9);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            font-weight: bold;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        `;
        errorDiv.textContent = message;
        document.body.appendChild(errorDiv);
        
        // Remove after 3 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 3000);
    }

    // Estimate command duration for client-side validation
    estimateCommandDuration(type, data = {}) {
        switch (type) {
            case 'move':
                return (data.pathLength || 1) * 1; // 1s per cell
            case 'watchSector':
                return data.duration || 5; // Duration specified by user
            case 'wait':
                return data.duration || 1; // 1s default wait
            default:
                return 1;
        }
    }

    canAddSpecificCommand(type, data = {}) {
        if (!this.canAddCommand()) return false;
        
        const currentTime = this.selectedUnit.getTotalTimelineLength ? this.selectedUnit.getTotalTimelineLength() : 0;
        const commandDuration = this.estimateCommandDuration(type, data);
        
        return (currentTime + commandDuration) <= 20;
    }

    setupWaitButton() {
        const waitButton = document.getElementById('waitButton');
        waitButton.addEventListener('click', () => {
            if (this.selectedUnit && this.canAddSpecificCommand('wait')) {
                this.socket.emit('planWait', {
                    unitId: this.selectedUnit.id,
                    duration: 1
                });
            } else if (this.selectedUnit) {
                this.showCommandError('Cannot add wait: Would exceed 20s timeline limit');
            }
        });
    }

    updateAndDrawParticles() {
        // Remove finished particles
        this.particles = this.particles.filter(p => p.progress < 1);
        // Draw and update
        this.particles.forEach(p => {
            // Interpolate position
            const x = p.from.x + (p.to.x - p.from.x) * p.progress;
            const y = p.from.y + (p.to.y - p.from.y) * p.progress;
            this.ctx.fillStyle = p.color;
            this.ctx.beginPath();
            this.ctx.arc(x, y, 6, 0, Math.PI * 2);
            this.ctx.fill();
            // Advance progress
            p.progress += p.speed;
        });
    }

    spawnAttackParticles(gameState) {
        // For each unit, check if it is executing an attack command
        gameState.units.forEach(unit => {
            if (!unit.commandChain) return;
            unit.commandChain.forEach(command => {
                if (command.type === 'attack' && !command.particleSpawned) {
                    const shooter = unit;
                    const target = gameState.units.find(u => u.id === command.data.targetId);
                    if (shooter && target) {
                        // Only spawn if not already present
                        const already = this.particles.some(p => p.unitId === shooter.id && p.targetId === target.id && p.commandStart === command.startTime);
                        if (!already) {
                            this.particles.push({
                                from: { x: shooter.x, y: shooter.y },
                                to: { x: target.x, y: target.y },
                                color: '#FFD700',
                                progress: 0,
                                speed: 1 / (60 * 5), // 5s duration at 60fps
                                unitId: shooter.id,
                                targetId: target.id,
                                commandStart: command.startTime
                            });
                        }
                    }
                }
            });
        });
    }

    updateAndDrawDamagePopups() {
        // Animate and draw popups
        this.damagePopups = this.damagePopups.filter(p => p.alpha > 0);
        this.damagePopups.forEach(p => {
            this.ctx.save();
            this.ctx.globalAlpha = p.alpha;
            this.ctx.fillStyle = '#F44336';
            this.ctx.font = 'bold 20px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(`-${p.amount}`, p.x, p.y);
            this.ctx.restore();
            p.y += p.vy;
            p.alpha -= 0.02;
        });
    }

    startVisualSectorSelection(gridX, gridY, mouseX, mouseY) {
        this.sectorSelectionMode = true;
        this.sectorGridX = gridX;
        this.sectorGridY = gridY;
        
        // Calculate initial direction based on mouse position
        const sectorWorldX = gridX * 40 + 20;
        const sectorWorldY = gridY * 40 + 20;
        this.sectorDirection = Math.atan2(mouseY - sectorWorldY, mouseX - sectorWorldX);
        
        // Show duration selection UI (small, non-blocking)
        this.showDurationSelector();
    }

    showDurationSelector() {
        // Create small, non-blocking duration selector
        const selector = document.createElement('div');
        selector.id = 'durationSelector';
        selector.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(40, 40, 40, 0.9);
            color: white;
            padding: 10px;
            border-radius: 5px;
            z-index: 1000;
            border: 1px solid #4CAF50;
            font-size: 12px;
        `;
        
        selector.innerHTML = `
            <div>Watch Duration:</div>
            <select id="durationSelect" style="margin-top: 5px;">
                <option value="1">1s</option>
                <option value="2">2s</option>
                <option value="3">3s</option>
                <option value="5" selected>5s</option>
                <option value="7">7s</option>
                <option value="10">10s</option>
            </select>
            <div style="margin-top: 5px; font-size: 10px; color: #aaa;">
                Move mouse to aim<br>
                Click to confirm<br>
                ESC to cancel
            </div>
        `;
        
        document.body.appendChild(selector);
        
        // Add ESC key listener
        document.addEventListener('keydown', this.handleSectorEscape.bind(this));
    }

    handleSectorEscape(e) {
        if (e.key === 'Escape' && this.sectorSelectionMode) {
            this.cancelSectorSelection();
        }
    }

    cleanupSectorSelection() {
        this.sectorSelectionMode = false;
        
        // Remove duration selector
        const selector = document.getElementById('durationSelector');
        if (selector && selector.parentNode) {
            selector.parentNode.removeChild(selector);
        }
    }

    confirmSectorSelection(duration) {
        if (this.canAddSpecificCommand('watchSector', { duration })) {
            this.socket.emit('planWatchSector', {
                unitId: this.selectedUnit.id,
                gridX: this.sectorGridX,
                gridY: this.sectorGridY,
                direction: this.sectorDirection,
                angle: this.sectorAngle,
                duration: duration
            });
        } else {
            this.showCommandError('Cannot add watch sector: Would exceed 20s timeline limit');
        }
        this.cleanupSectorSelection();
    }

    cancelSectorSelection() {
        this.cleanupSectorSelection();
    }

    drawSectorPreview() {
        if (!this.sectorSelectionMode) return;
        
        const sectorWorldX = this.sectorGridX * 40 + 20;
        const sectorWorldY = this.sectorGridY * 40 + 20;
        
        // Draw preview cone with different styling
        this.drawSectorCone(
            sectorWorldX, 
            sectorWorldY, 
            this.sectorDirection, 
            this.sectorAngle, 
            (this.selectedUnit.shootRange || 5) * 40,
            'rgba(0, 255, 255, 0.2)', // Cyan with transparency for preview
            'rgba(0, 255, 255, 0.8)'  // Cyan border for preview
        );
        
        // Draw center point
        this.ctx.fillStyle = 'rgba(0, 255, 255, 0.8)';
        this.ctx.beginPath();
        this.ctx.arc(sectorWorldX, sectorWorldY, 8, 0, Math.PI * 2);
        this.ctx.fill();
    }

    updateMatchmakingUI(data) {
        const playersList = document.getElementById('playersList');
        const matchmakingTimer = document.getElementById('matchmakingTimer');
        const matchmakingTitle = document.getElementById('matchmakingTitle');
        
        // Update players list
        playersList.innerHTML = '';
        data.players.forEach(player => {
            const playerDiv = document.createElement('div');
            playerDiv.style.cssText = 'margin: 5px 0; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 5px;';
            playerDiv.innerHTML = `<strong>${player.username}</strong> ${player.id === this.playerId ? '(You)' : ''}`;
            playersList.appendChild(playerDiv);
        });
        
        // Update timer
        if (data.timeRemaining > 0) {
            matchmakingTimer.textContent = `Starting in ${data.timeRemaining}s...`;
            matchmakingTitle.textContent = `🎮 ${data.players.length} Player${data.players.length > 1 ? 's' : ''} Found!`;
        } else {
            matchmakingTimer.textContent = 'Starting game...';
        }
    }
}

// Global reference for timeline functionality
let gameClient; 