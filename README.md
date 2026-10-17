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
- `UPLOAD_DIR=/var/lib/rfid-planner/uploads` (where project documents are stored)
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

## Install on cPanel shared hosting ("Setup Node.js App")

1. **Node.js version**: choose **20** (or 18 / 22). Older versions such as 10 or 16 can't run this app.
2. **Application mode**: Production.
3. **Application root**: a folder **outside** `public_html`, for example `rfid-planner`. Files in `public_html` can be downloaded by anyone.
4. **Application URL**: your domain, e.g. `app.cyber-dawn.com`, with the path box left empty.
5. **Application startup file**: `server.js`
6. **Passenger log file**: e.g. `/home/USER/logs/rfid-planner.log`
7. **Environment variables** (same page): `DATABASE_PATH=/home/USER/rfid-data/planner.db`, `UPLOAD_DIR=/home/USER/rfid-data/uploads`, `BACKUP_DIR=/home/USER/rfid-data/backups`, `APP_URL=https://your-domain`, `CRON_SECRET=` a long random value. Create the app, then upload the project files (without `node_modules`, `.next` and `data/*.db`) into the application root and extract them.
8. Press **Run NPM Install**.
9. Open **Terminal** in cPanel, paste the "Enter to the virtual environment" command shown at the top of the app page, then run `npm run build`.
10. Put your data in place: copy your latest `planner.db` (from your PC's `data\backups`) to the `DATABASE_PATH` folder, **or** run `DATABASE_PATH=/home/USER/rfid-data/planner.db npm run import-data`.
11. Press **Restart**. Open your domain with **https://** (turn on AutoSSL in cPanel if needed).
12. Follow-up emails: in cPanel **Cron Jobs**, every 15 minutes: `curl -s -X POST -H "x-cron-secret: YOUR_CRON_SECRET" https://your-domain/api/cron/followups > /dev/null`. Backups run by themselves.

After updating files: run `npm install` and `npm run build` again in the terminal, then **Restart**.

## Signing in

Open `https://planner.yourcompany.com`.

- **Your data was imported**: sign in with the same login ID and password you set in the planner (`shashi`). Team members who had a prepared login (`vikram`, `yash.pratap`, `chirag`) can sign in with the passwords you gave them.
- **Fresh install without data**: the first visit shows **First-time setup** to create the admin account.
- **Locked out?** On the server: `DATABASE_PATH=/var/lib/rfid-planner/planner.db node scripts/create-admin.mjs <loginId> <newPassword>` creates or resets an admin login.

Passwords that were imported are stored only as hashes, so **Admin settings → Users & access** shows "edit the login to see it" for them. Set them again there if you want admins to be able to view them.

## Changing your own password

Everyone with a login can change their own password with the **key button** next to Sign out (bottom of their name card in the menu). They enter the current password and the new one twice (at least 8 characters). Admins still see the password in **Admin settings → Users & access**, marked "changed by them on …". After a change, the person's other devices are signed out; the device they used stays signed in. An admin setting a new password signs the person out everywhere.

## Adding your team

1. **Admin settings → Team**: add the person (name, role, email ID, skills, hours, leave).
2. **Admin settings → Users & access**: choose their account type, press **Set login**, enter a login ID and password, and save. Their account works immediately.
3. Use the switch to **disable** an account at once, or **Remove** to delete the login.

---

## Subtasks outside their main task

If a subtask's dates go outside its main task (one that has its own dates), saving asks to **stretch the main task** so the subtask fits; main tasks above it stretch too if needed. Only the main task's owner, the project lead or an admin can approve it. Moving linked tasks and the Load advisor stretch main tasks the same way.

The stretch stays visible for the life of the task: on the Gantt the added part of the main task's bar is striped amber with a label such as "+10d ← model making", a grey line above the bar marks the original plan, and the task gets a ↔ flag. The main task's form lists the original dates and every stretch (who, when, which subtask), and History records each one. The Gantt PDF/PNG export shows the stripes too.

## Milestones

- In a task, tick **Milestones** and type each milestone's name; **+ Add milestone** adds more, ↑ ↓ reorder them. A target date is optional (it must fall within the task's dates).
- They keep the order you add them in, here and on the Gantt (◆ on the task bar: hollow = open, green = completed, red outline = overdue). Milestones without a date are spaced evenly along the bar.
- The task's progress is worked out automatically: completed ÷ total, in any order (7 of 10 = 70%). All completed marks the task Done, and the project's progress follows from its tasks.
- Complete milestones from **Add follow-up update** (tick them) or from **Follow-ups → Milestones**, which lists every milestone with filters, overdue count and CSV export. Each completion is recorded as a follow-up update and in History.
- The task owner, the project lead and admins can complete milestones, and **Reopen** a completed one from Follow-ups → Milestones. Reopening needs a remark; it lowers the task's progress, is shown under the milestone, and is recorded as a follow-up update and in History.

## My leave and company holidays

- **My leave** (everyone with a team profile, including View only): the calendar button next to your name. Add leave (from, to, half day for a single day, reason) or cancel future leave. It takes effect straight away in Resource load, the Load advisor and Best fit, and warns if you own tasks in those days. Your project leads (where you have open tasks) and admins get an email after the 10-minute hold. Past leave can only be changed by an admin (Team → person → Leave). The server only lets a person change their own leave; the rest of a team profile stays admin-only.
- **Import holidays** (admins): Admin settings → Skills & calendar → **Import holidays (.xlsx / .csv)**. Use **Download template** (Date, Holiday name, Type: National / Office / Optional), or a sheet from HR with a date column and a name column. Dates like 26/01/2027, 2027-01-26, 26-Jan-2027 or Jan 26, 2027 are understood. You see what's new, already there or skipped before importing; nothing is deleted.

## Reporting a delay

The task owner (or the project lead or an admin) opens the task, or its row in Follow-ups, and presses **Report delay**: choose the reason (Technical issue, Supplier / material, Customer input, Testing / certification failed, Resource unavailable, Other), say what happened, and give the new finish as extra working days or a new end date. Evidence (a test report, a supplier mail) can be attached; it goes to the project's documents. A preview shows what moves before saving. No approval is needed.

- The task's end date moves; tasks that wait on it (finish → start) move after it automatically.
- The task keeps its original plan; the delayed part shows in red on the timeline (and in the exported Gantt) with the total, e.g. "+2d". The delay is also logged as a follow-up update ("Delay reported").
- Project stakeholders (lead, task owners, View only people with the project ticked, admins if switched on) get an email after the 10-minute hold, with the reason, the new dates, the linked tasks that moved and a warning if the project forecast passes its target.
- **Project target moves automatically (default)**: when a reported delay, a holiday or someone's leave pushes the work past the project's target, the target moves to the new finish. The original target is kept (shown as "was …, moved by delays" on the project page), the change is recorded with its reason, and stakeholders are emailed ("⚠ Project target moved automatically 28/10 → 30/10, because …"). Untick **Move the target automatically when delays push work past it** in Project details to keep a fixed target; stakeholders then get the "forecast past target" warning instead. Changing the target by hand makes that the new commitment.
- **Follow-ups → Delays** lists every delay with a chart of delay days by reason (largest first, with cumulative %), filtered by project or person, and **Export CSV**. Each project's **Details & documents** shows its own delays.

## Holidays and leave on the timeline

- **Holidays** show as a **purple** band across the whole project timeline; **leave** shows as a **black** block on the task bars of the person on leave (a half day is a half-height block). Hover for the name or reason. Both also appear in the exported Gantt (PNG/PDF) with a legend.
- **Dates move automatically**: when a holiday is added, or someone adds leave, every open task affected keeps its number of working days, so its end date moves out (and its start moves if it falls on the new day off). Tasks that wait on it (finish → start) move after it. Removing the holiday or cancelling the leave moves the dates back, because each task remembers its planned start.
- Not moved: tasks that are done, the start date of tasks already started, tasks in Completed or Aborted projects, and half days of leave. Changing a task's start by hand makes that the new planned start.
- Subtasks may move past their main task; that's shown on the timeline, not corrected.
- **Stakeholders are told**: each automatic move sends a project update (after the 10-minute hold) to the project lead, task owners, View only people with the project ticked, and admins if switched on. It lists each task's old → new dates with the reason, flags subtasks now running past their main task, and warns when the project forecast goes past its target. If the holiday or leave is removed within the 10 minutes, nothing is sent.
- If someone has the task open while its dates move, the form updates its dates on the spot with a note (“Dates updated because Vikram added leave”). If they had already changed the dates themselves, theirs are kept and the note says what the new dates would have been.
- Each automatic move is listed in History ("Dates moved automatically …"), and the task form shows the holidays and leave inside the task's dates.

## Who can change what

| Person | Can do |
|---|---|
| **Admin** | Everything |
| **Project lead** (the "Project lead" of a project) | Edit or delete the project; add, edit, reschedule and delete all its tasks; follow-ups and documents |
| **Task owner** | Update their own tasks (dates, progress, status, effort, notes, links, follow-up settings), add subtasks under their own tasks, add follow-up updates to them, upload documents to that project. They can't change who owns a task or delete it. |
| **Other Read & write users** | Read the project; create new projects of their own |
| **View only with "Can add new projects"** | See the projects ticked for them; create new projects (all details and attachments); edit the details and documents of projects they added. No tasks, no deleting. |
| **Read only / View only** | Read only |

When a View only person creates or edits a project, **Project lead**, **Project technical summary** and **Additional technical inputs** are locked for them (the lead or an admin fills them in); follow-up settings stay open.

**Letting a View only person add projects.** Team → open the person → User type *View only* → tick **Can add new projects** → Save. Each project they create is ticked in their "Projects this person can see" list automatically (marked *added by them*). To take away their view and edit access to one project, untick it there. To stop them adding projects at all, untick **Can add new projects**.

The server enforces these rules, not just the screen. A login must be linked to a team member (Admin settings → Users & access) for its owner and lead rights to work.

## Project details and documents (ISO design records)

Open a project and choose **Details & documents**.

- **Project details**: assigned by and date, technical summary, reference product, additional technical inputs and description. Edit them with **Edit** or from **Project details**.
- **Documents**: **Upload documents** takes several files at once (PDF, images, Word/Excel/PowerPoint, CAD/PCB, ZIP, up to 25 MB each). Every file needs a **remark** saying what it is, plus a **category** and **revision**, and can be linked to a task.
- PDFs and pictures open inside the planner with **View**. Other types download.
- **New revision** uploads a replacement. The old file stays on record, marked *Superseded*.
- Files are never deleted. Admins can **Archive** (and **Restore**) them. Every upload, edit, revision and archive is written to **History** with who and when, and each file's SHA-256 fingerprint is stored.
- Files are kept in `UPLOAD_DIR` (default: `uploads` next to the database), never in the public web folder, and only signed-in users can open them. The nightly backup copies new files too.

## Project status: Completed and Aborted

- **Planning, Active, On hold** are chosen in Project details. On hold stays editable.
- **Completed** is set automatically when every task is done and every milestone is achieved. It can't be chosen by hand.
- **Aborted**: the project lead or an admin presses **Abort project** on the project page and writes a comment. An admin can also let a **View only** person abort the projects ticked for them: Team → open the person → tick **Can abort projects**. They can't reopen.

A Completed or Aborted project is **frozen** for everyone, admins included: no changes to tasks, dates, owners, progress, milestones, follow-ups, documents or project details. It leaves the resource load, the Load advisor and the follow-up reminders. **Daily log entries can still be added** against it.

- **Reopen project** (lead or admin, comment required) sets it back to Active.
- On a **Completed** project the lead or an admin can still **add a task**, giving the reason (for example a customer ECN). The project goes back to Active and completes again when the new work is done.
- Every change is listed under **Details & documents → Status history** and in History, and stakeholders are emailed (with the comment).

The server enforces these rules.

## Daily log in the resource load

- Days with log entries (including **today**, as soon as it's logged) show the logged hours instead of the plan; when someone has logged today, their remaining task work is spread from tomorrow.
- Each person's average routine non-project work (meetings, support, admin) over the last 4 weeks of log entries (at least 3 logged days) is added to their future working days. Where time is booked ahead, the larger of the two counts.
- The same figures are used everywhere: Resource load, the Load advisor (its cards show e.g. "incl. 5 h routine work"), the overload banner and Best fit.

## Book time ahead and hours lost to other work

The Daily log is for work already done; dates in the future can't be logged. For non-project work you already know is coming, use **Daily log → Book time ahead**.

- A booking has dates, **hours a day**, a type (routine work, production support, meetings, training, travel, other), an optional project and a note, and can **repeat every week** until a date. Everyone books their own time; admins can book for anyone. Bookings start today or later; one already under way can only be ended early.
- **Productive hours a day minus booked hours** is what is left for project tasks. Each task works a set number of hours a day (its effort spread over its dates, or the whole productive day when it has no effort). When a day has less time left than the task needs, the lost hours add up and the task's end moves out; a **full-day booking works like leave**. Linked tasks, the project target (when it moves automatically) and the stakeholder emails follow, the same as for leave.
- The same rule applies to the **Daily log**: on a day already logged, hours logged on anything other than the task itself (other projects, non-project work) are taken from that task's time. Logging, changing or deleting such an entry moves the dates straight away (and back).
- Each task remembers the work it needs from when its plan was last set by hand, so repeated moves don't drift and cancelling a booking moves dates back.
- On a booked day, **My diary** shows the booking with **Confirm** (logs it as booked) or **Adjust** (opens a pre-filled entry). It only becomes a log entry once confirmed.
- Booked hours count in Resource load, the Load advisor, Best fit and the overload warnings (per day the larger of the booking and the person's usual routine work, so they aren't counted twice).
- On the timeline, booked time of a task's owner shows as **grey** blocks on the task: solid for a full day, striped for part of a day.

## Load advisor (balancing the team's load)

Open **Resource load → Load advisor**, or the banner on the Overview. It looks at the next 12 weeks and, for each overloaded person-week, proposes fixes with the best one first:

- **Transfer** a task to a teammate who has the task's skill (Expert first), has free hours in every week the task runs, isn't on leave and is within their limit of tasks at once.
- **Shift later** within the task's slack (same owner, no linked task or project target moves).
- **Escalation** when nothing else fits: **delay** or **extend** a task. Tasks that wait on it move too, and the project target moves if needed.

Work from lower-priority projects is moved first. Tasks are never split. Each fix shows its effect (for example *Vikram 180% → 100%*). Pick a fix and press **Apply**, or **Apply all chosen**. **Undo last** reverses the last batch of shifts and escalations.

Only **admins** and the **project lead** can apply fixes for a project; others see the advice only.

**Transfers need the new owner's acceptance.** Applying a transfer sends a request; the new owner sees a banner (*Review*) and accepts or declines it with a note. The task changes owner only when they accept. The request is emailed to the new owner (after the usual 10-minute hold); a refusal is emailed to the person who asked and the project lead; an accepted transfer is announced to the project's stakeholders. Leads and admins can cancel a waiting request in the Load advisor. The server enforces this: the new owner can only accept or decline, and task owners can't request transfers.

When adding or editing a task, **Best fit** under the owner list suggests the person with the skill and the most room, with one click to assign.

## Project updates to stakeholders (email)

Set up in **Admin settings → Email → Project updates to stakeholders**. The sender account on the same page must be saved first.

**Who gets them, for each project:** the project lead, every task owner in the project, View only people who have the project ticked in "Projects this person can see", and admins (switch **Admins get updates for every project** off to send admins only the projects they lead or own tasks in). Everyone needs an email ID in their team profile. Each person gets one email covering all their projects.

**Event updates** are sent when a milestone is completed or reopened (with the reason), a task is finished, a project's status changes, or its target finish date moves. Each change waits **10 minutes** first. If it is undone within the 10 minutes, nothing is sent; changes made in the same window go out together. Admins see the waiting changes on the same page and can stop one with **Don't send**.

**Weekly summary** goes out on the day and time you choose (IST): progress, tasks done, milestones completed this week, overdue and coming milestones, and overdue tasks for every open project. Use **Preview weekly summary** to see who would get it, or **Send weekly summary now** to send it straight away.

These run inside the planner server and need no cron job. Set `STAKEHOLDER_UPDATES=0` in `.env.local` to switch them off on a test copy.

## Backups (built in)

- **Automatic**: the planner server copies the whole database once a day (about a minute after it starts, then every day) into a `backups` folder next to the database, keeps the last 30 copies, and copies new documents into `backups/uploads`. This also works on a Windows PC: nothing to set up. Change the folder with `BACKUP_DIR`, the number kept with `BACKUP_KEEP`, or switch it off with `AUTO_BACKUP=0`.
- **Admin settings → Backup & export** (admins): see the backups, **Back up now**, and **Download** any backup file. Keep a downloaded copy on another drive now and then: a backup on the same disk doesn't survive a disk failure.
- **Save full backup (.json)** and **Download Excel (.xlsx)**: all planner data as one file / as readable sheets for audits. Passwords are never included.
- **Restore from a backup**: choose a `.json` backup, check what it contains, then restore. Missing items are added back; tick the box to also replace items that differ. Nothing is deleted.
- **Documents (attachments)**: **Download documents (.zip)** saves the uploaded files with their details (category, revision, remarks, who and when), for all projects or one project. **Restore documents** takes such a ZIP and adds back any files and details that are missing; nothing is overwritten or deleted, and each file is checked against its saved fingerprint. A ZIP re-packed with Windows or 7-Zip also works. Archives must stay under 4 GB (download one project at a time if needed).
- Restoring a `.json` backup also brings back document details, where the file itself is still on the server.
- Restoring a whole database file (`.db`): stop the planner, copy the backup over `planner.db`, start it again (see the table below).

## Daily log (work diary)

**Daily log** in the menu is a diary, separate from projects. Each person records what they did each day: hours, type of work, what was done, an optional link to a project or task, result / blockers and a plan for tomorrow.

- **My diary**: a month calendar coloured by hours logged. Working days with nothing logged are marked, and the menu shows how many of the last 7 days are missing.
- **Team diary**: admins see everyone; project leads see entries linked to their projects. Filter by person, dates, type of work and project, and export to CSV.
- **Monthly timesheet** (admins): person × day hours with totals and missing days, exported to CSV or PDF.
- Hours logged against a task show on that task as **actual hours**. In **Resource load**, logged hours replace planned hours on the days people logged, and regular non-project work (the 4-week average) is added to the weeks ahead.
- People can change their own entries for 7 days after writing them; after that only an admin can. The server enforces who may read and change each entry, and every change is written to History.

## Everyday maintenance

| Task | Command (in `/var/www/rfid-planner`) |
|---|---|
| See if it's running | `pm2 status` |
| View errors | `pm2 logs rfid-planner` |
| Restart | `pm2 restart rfid-planner` |
| Manual backup | `DATABASE_PATH=/var/lib/rfid-planner/planner.db BACKUP_DIR=/var/backups/rfid-planner node scripts/backup.mjs` |
| Restore a backup | `pm2 stop rfid-planner && cp /var/backups/rfid-planner/planner-XXXX.db /var/lib/rfid-planner/planner.db && cp -n /var/backups/rfid-planner/uploads/* /var/lib/rfid-planner/uploads/ && pm2 start rfid-planner` |
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
