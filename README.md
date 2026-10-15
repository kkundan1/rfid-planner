# RFID R&D Planner (Next.js)

Projects, nested tasks, dependencies, follow-ups, resource load and Gantt export for the RFID R&D team, now running on your own server.

- **Next.js 14** (JavaScript, App Router)
- **SQLite** database: one file, no database server to install
- **Real logins**: login ID and password checked by the server; Admin, Read & write and Read only are enforced by the server
- **Follow-up emails** sent by the server through your SMTP mailbox
- Your current data (projects, tasks, team, skills, follow-ups, history and logins) is included in `data/seed.json`

---

## What's in the folder

| Path | What it is |
|---|---|
| `app/` | Pages (`/` planner, `/login`) and API routes (`/api/...`) |
| `lib/planner-engine.js` | The planner screens and logic (same as the claude.ai version) |
| `lib/claude-shim.js` | Connects the planner screens to this server's API |
| `lib/store.js` | Who may read and write what (server-side permissions) |
| `lib/auth.js` | Logins and sessions |
| `lib/followups.js` | Builds and sends the daily follow-up emails |
| `scripts/` | Data import, emergency admin login, backups |
| `deploy/` | PM2, Nginx and crontab examples |
| `data/seed.json` | Your exported planner data. **Keep it private** (it contains login hashes). Delete it from the server after importing. |

---

## Install on an Ubuntu VPS (step by step)

You need: an Ubuntu 22.04/24.04 VPS (1 GB RAM is enough), a domain such as `planner.yourcompany.com` pointing to the VPS IP (an **A record** at your domain provider), and SSH access.

### 1. Install Node.js, build tools, Nginx and PM2

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 nginx
sudo npm install -g pm2
node -v    # should show v20.x
```

### 2. Upload the project

From your computer (or use WinSCP / FileZilla to copy the unzipped folder):

```bash
scp rfid-planner.zip youruser@YOUR_VPS_IP:~
```

On the VPS:

```bash
sudo mkdir -p /var/www /var/lib/rfid-planner /var/backups/rfid-planner
sudo chown -R $USER /var/www /var/lib/rfid-planner /var/backups/rfid-planner
cd /var/www && unzip ~/rfid-planner.zip && cd rfid-planner
```

### 3. Settings

```bash
cp .env.example .env.local
nano .env.local
```

Set:

- `DATABASE_PATH=/var/lib/rfid-planner/planner.db`
- `CRON_SECRET=` a long random value. Create one with `openssl rand -hex 32`.
- `APP_URL=https://planner.yourcompany.com`
- Leave `INSECURE_COOKIES=0`.

### 4. Install, import your data, build

```bash
npm install
DATABASE_PATH=/var/lib/rfid-planner/planner.db npm run import-data
rm data/seed.json          # no longer needed on the server
npm run build
```

### 5. Start it and keep it running

```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup               # run the command it prints, so it starts after a reboot
```

Check: `curl -I http://127.0.0.1:3000/login` should answer `200`.

### 6. Connect your domain with Nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/rfid-planner
sudo nano /etc/nginx/sites-available/rfid-planner      # put your domain in server_name
sudo ln -s /etc/nginx/sites-available/rfid-planner /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 7. Free HTTPS certificate

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d planner.yourcompany.com
```

The certificate renews automatically. **HTTPS is required**: the login cookie only works over HTTPS.

### 8. Firewall

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

### 9. Follow-up emails and nightly backups

```bash
crontab -e
```

Paste the two lines from `deploy/crontab.txt`, replacing `YOUR_CRON_SECRET` with your value. Then in the planner open **Admin settings → Email**, fill in the sender account (use an **app password** for Gmail / Microsoft 365), tick the people to notify and set the sending time.

Preview what would be sent, without sending anything:

```bash
curl -s -X POST -H "x-cron-secret: YOUR_CRON_SECRET" "http://127.0.0.1:3000/api/cron/followups?dry=1"
```

---

## Signing in

Open `https://planner.yourcompany.com`.

- **Your data was imported**: sign in with the same login ID and password you set in the planner (`shashi`). Team members who had a prepared login (`vikram`, `yash.pratap`, `chirag`) can sign in with the passwords you gave them.
- **Fresh install without data**: the first visit shows **First-time setup** to create the admin account.
- **Locked out?** On the server: `DATABASE_PATH=/var/lib/rfid-planner/planner.db node scripts/create-admin.mjs <loginId> <newPassword>` creates or resets an admin login.

Passwords that were imported are stored only as hashes, so **Admin settings → Users & access** shows "edit the login to see it" for them. Set them again there if you want admins to be able to view them.

## Adding your team

1. **Admin settings → Team**: add the person (name, role, email ID, skills, hours, leave).
2. **Admin settings → Users & access**: choose their account type, press **Set login**, enter a login ID and password, and save. Their account works immediately.
3. Use the switch to **disable** an account at once, or **Remove** to delete the login.

---

## Everyday maintenance

| Task | Command (in `/var/www/rfid-planner`) |
|---|---|
| See if it's running | `pm2 status` |
| View errors | `pm2 logs rfid-planner` |
| Restart | `pm2 restart rfid-planner` |
| Manual backup | `DATABASE_PATH=/var/lib/rfid-planner/planner.db BACKUP_DIR=/var/backups/rfid-planner node scripts/backup.mjs` |
| Restore a backup | `pm2 stop rfid-planner && cp /var/backups/rfid-planner/planner-XXXX.db /var/lib/rfid-planner/planner.db && pm2 start rfid-planner` |
| Install an update | upload new files (keep `.env.local`), then `npm install && npm run build && pm2 restart rfid-planner` |

Copy the backups folder off the server now and then (to Google Drive or a NAS), so a server failure can't take the data with it.

## Run it on your own computer (testing)

```bash
npm install
INSECURE_COOKIES=1 npm run dev     # Windows PowerShell:  $env:INSECURE_COOKIES=1; npm run dev
```

Open http://localhost:3000. The database is created at `data/planner.db`.

## Notes

- Changes made by one person appear on everyone's screen within about 3 seconds.
- Run a single instance (as in `ecosystem.config.js`). SQLite comfortably handles a team of this size.
- The planner screens currently live in `lib/planner-engine.js`, ported unchanged from the claude.ai version. They can be split into React components step by step without changing the server, database or API.
