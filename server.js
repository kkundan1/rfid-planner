// Startup file for cPanel "Setup Node.js App" (Phusion Passenger) or any host
// that runs a single Node.js file. Run "npm run build" once before starting.
const { createServer } = require('http');
const path = require('path');
const fs = require('fs');

// Load settings from .env.local / .env when the host doesn't set them.
for (const f of ['.env.local', '.env']) {
  const p = path.join(__dirname, f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
process.env.NODE_ENV = 'production';

if (!fs.existsSync(path.join(__dirname, '.next', 'BUILD_ID'))) {
  console.error('The app has not been built yet. Run "npm run build" in the application folder, then restart.');
}

const next = require('next');
const app = next({ dev: false, dir: __dirname });
const handle = app.getRequestHandler();
const port = parseInt(process.env.PORT || '3000', 10);

app.prepare().then(() => {
  createServer((req, res) => handle(req, res)).listen(port, () => {
    console.log(`RFID R&D Planner ready on port ${port}`);
    // Start the background jobs (daily backup, stakeholder update emails).
    setTimeout(() => { require('http').get(`http://127.0.0.1:${port}/api/health`, (r) => r.resume()).on('error', () => {}); }, 2000);
  });
}).catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
