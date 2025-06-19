# Ubuntu Server Deployment Guide with PM2

## Prerequisites

### 1. Update Ubuntu System
```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Node.js (using NodeSource repository for latest LTS)
```bash
# Install curl if not already installed
sudo apt install curl -y

# Add NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -

# Install Node.js
sudo apt install nodejs -y

# Verify installation
node --version
npm --version
```

### 3. Install PM2 globally
```bash
sudo npm install -g pm2
```

### 4. Install Git (if not already installed)
```bash
sudo apt install git -y
```

## Project Setup

### 1. Clone or Transfer Project Files
If using Git:
```bash
git clone <your-repository-url>
cd browser_game
```

Or if transferring files manually:
```bash
# Create project directory
mkdir -p /home/ubuntu/browser_game
cd /home/ubuntu/browser_game

# Transfer your project files here
# You can use scp, rsync, or any file transfer method
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Create Logs Directory
```bash
mkdir logs
```

### 4. Test the Application
```bash
# Test run to make sure everything works
npm start
```
Press `Ctrl+C` to stop the test run.

## PM2 Deployment

### 1. Start Application with PM2
```bash
# Start using the ecosystem config
pm2 start ecosystem.config.js --env production

# Or start directly
pm2 start server.js --name "browser-strategy-game"
```

### 2. Save PM2 Process List
```bash
pm2 save
```

### 3. Setup PM2 Startup Script (Auto-start on boot)
```bash
pm2 startup
# Follow the instructions provided by the command above
# It will give you a command to run with sudo
```

### 4. Useful PM2 Commands
```bash
# Check status
pm2 status

# View logs
pm2 logs browser-strategy-game

# Restart application
pm2 restart browser-strategy-game

# Stop application
pm2 stop browser-strategy-game

# Delete application from PM2
pm2 delete browser-strategy-game

# Monitor in real-time
pm2 monit
```

## Firewall Configuration

### 1. Enable UFW Firewall
```bash
sudo ufw enable
```

### 2. Allow SSH and HTTP/HTTPS
```bash
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000  # Your game port
```

### 3. Check firewall status
```bash
sudo ufw status
```

## Optional: Nginx Reverse Proxy

If you want to serve the game on port 80/443 instead of 3000:

### 1. Install Nginx
```bash
sudo apt install nginx -y
```

### 2. Create Nginx Configuration
```bash
sudo nano /etc/nginx/sites-available/browser-game
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain or server IP

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. Enable the Site
```bash
sudo ln -s /etc/nginx/sites-available/browser-game /etc/nginx/sites-enabled/
sudo nginx -t  # Test configuration
sudo systemctl restart nginx
```

## Monitoring and Maintenance

### 1. Check Application Status
```bash
pm2 status
pm2 logs browser-strategy-game --lines 50
```

### 2. Monitor System Resources
```bash
htop  # Install with: sudo apt install htop
pm2 monit
```

### 3. Update Application
```bash
# Pull latest changes (if using Git)
git pull

# Restart with PM2
pm2 restart browser-strategy-game
```

## Troubleshooting

### Common Issues:

1. **Port already in use**: Change the PORT in ecosystem.config.js
2. **Permission denied**: Make sure files have correct permissions
3. **Module not found**: Run `npm install` again
4. **Can't connect**: Check firewall settings and ensure port 3000 is open

### Check Logs:
```bash
pm2 logs browser-strategy-game
tail -f logs/combined.log
```

## Security Considerations

1. **Keep system updated**: `sudo apt update && sudo apt upgrade`
2. **Use strong passwords** for server access
3. **Consider SSL/TLS** if serving over the internet
4. **Regular backups** of your game data
5. **Monitor logs** for suspicious activity

Your browser strategy game should now be running on Ubuntu server with PM2! 