# Browser Strategy Game

A real-time multiplayer top-down strategy game with two-phase gameplay: Planning and Execution.

## 🎮 Game Features

- **Two-Phase Gameplay**: 
  - **Planning Phase** (60 seconds): Give orders to your units
  - **Execution Phase** (3 seconds): Watch all commands execute simultaneously
- **Multiplayer**: Real-time multiplayer for 2 players using WebSockets
- **Top-Down Strategy**: Command units to move and attack in tactical combat
- **Real-time Updates**: Live game state synchronization between players

## 🚀 Quick Start

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start the Server**:
   ```bash
   npm start
   ```

3. **Open the Game**:
   - Navigate to `http://localhost:3000`
   - Share the URL with a friend to play together!

## 🎯 How to Play

### Planning Phase (60 seconds)
- **Select Units**: Left-click on your units (green for Player 1, red for Player 2)
- **Move Orders**: After selecting a unit, left-click where you want it to move
- **Attack Orders**: Right-click on enemy units to plan attacks
- **Visual Feedback**: See planned moves as dotted lines and attack targets with crosshairs

### Execution Phase (3 seconds)
- All planned commands execute simultaneously
- Units move toward their targets and attack enemies in range
- Health bars show unit status
- Dead units are removed from the battlefield

### Victory Condition
- Eliminate all enemy units to win the game!

## 🛠️ Technical Details

### Backend (Node.js + Socket.IO)
- Real-time multiplayer communication
- Game state management
- Turn-based phase system
- Unit command processing

### Frontend (HTML5 Canvas + JavaScript)
- Smooth 60 FPS rendering
- Interactive unit selection and command input
- Real-time visual feedback for planned actions
- Responsive UI with game status indicators

### Game Mechanics
- **Unit Stats**: Health (100), Damage (25), Range (100), Speed (2)
- **Planning Time**: 60 seconds per planning phase
- **Execution Time**: 3 seconds for command execution
- **Map Size**: 800x600 pixels

## 🎨 Controls

- **Left Click**: Select your units or set move targets
- **Right Click**: Set attack targets on enemy units
- **Visual Indicators**:
  - Gold outline: Selected unit
  - Green dotted line: Your planned moves
  - Red dotted line: Enemy planned moves
  - Red crosshair: Attack targets

## 🔧 Development

For development with auto-restart:
```bash
npm run dev
```

## 📝 Game Rules

1. Each player starts with 3 units
2. Players alternate between planning and execution phases
3. During planning, you have 60 seconds to give orders
4. All orders execute simultaneously during the execution phase
5. Units can move and attack in the same turn
6. Last player with surviving units wins

## 🌟 Future Enhancements

- Different unit types (archers, cavalry, etc.)
- Larger maps with obstacles
- Power-ups and special abilities
- Spectator mode
- Tournament system
- AI opponents

Enjoy the tactical combat! ⚔️ 