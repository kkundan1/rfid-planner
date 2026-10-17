// PM2 keeps the planner running and restarts it after a crash or reboot.
//   pm2 start deploy/ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'rfid-planner',
    cwd: '/var/www/rfid-planner',
    script: 'node_modules/next/dist/bin/next',
    args: 'start -p 3000',
    instances: 1,            // keep 1: SQLite works best with a single process
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production', TZ: 'Asia/Kolkata' },
  }],
};
