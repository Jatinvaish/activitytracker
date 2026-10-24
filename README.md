# Activity Tracker

A desktop time tracker for small teams. Employees install the app once, type their name, and it runs silently in the system tray, recording when they are active, idle, away, on a break or in a meeting. The owner sees everything live in a web admin console and approves corrections that employees request.

- **Desktop app**: Electron, for Windows, macOS and Linux. It auto-starts with the PC and auto-updates from GitHub Releases.
- **Backend**: Node.js/Express on Render. It stores data in Supabase (PostgreSQL + Storage) and sends email through Gmail SMTP.
- **Admin console**: a web page served by the backend at `/admin`.

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [Prerequisites](#prerequisites)
4. [Run everything locally](#run-everything-locally)
5. [Check that it works](#check-that-it-works)
6. [Tests](#tests)
7. [What gets tracked](#what-gets-tracked)
8. [Settings](#settings)
9. [API reference](#api-reference)
10. [Database](#database)
11. [Build installers](#build-installers)
12. [Release and deploy](#release-and-deploy)
13. [Troubleshooting](#troubleshooting)
14. [Security and privacy](#security-and-privacy)

---

## How it works

```
 Employee PC                              Render (backend)                      Supabase
┌──────────────────────────┐   HTTPS    ┌───────────────────────────┐        ┌──────────────────────┐
│ Electron main process    │──────────▶│ /v2/*   desktop API        │──────▶│ PostgreSQL tables    │
│  • tracking engine (1 s) │  every 2m  │ /admin  admin console page │        │ Storage: screenshots │
│  • upload queue on disk  │◀──────────│ /admin/api/*  admin API    │        └──────────────────────┘
│  • tray, notifications   │  settings, │ email via Gmail SMTP       │
│ Window: Today/History/   │  decisions └───────────────────────────┘
│         Requests         │                         ▲
└──────────────────────────┘                         │ browser
                                               Owner (admin console)
```

1. **First launch**: the employee enters their name and accepts the consent screen. The app registers the computer with `POST /v2/register` and receives its **own token**.
   - The employee's first computer is approved automatically.
   - Any further computer under the same name waits until the owner approves it in the admin console.
2. **Tracking**: every second the main process reads the system idle time and lock state, then decides the current status: active, idle, away, break or meeting. Each status change closes a *segment* and opens a new one.
3. **Sync**: every 2 minutes, or within 3 seconds of a status change, one `POST /v2/sync` call uploads:
   - the live status
   - all finished segments
   - activity per 10-minute slot
   - app usage per hour

   Anything that fails to upload stays in `upload-queue.json` on the PC and is retried with back-off, so going offline never loses time.
4. **Corrections**: the employee clicks **Request a change** on a session. The owner gets an email, then approves or rejects it in the admin console, optionally fixing the session. The employee gets a desktop notification.

---

## Repository layout

```
main.js                 Electron entry: windows, tray, IPC, notifications, auto-update
index.html              Employee window (setup, consent, Today / History / Requests)
prompt.html             "Where were you?" pop-up after long idle
app/
  tracker.js            Tracking engine (status machine, segments, activity, apps, midnight split, crash recovery)
  sync.js               Registration, sync loop, back-off, employee data requests
  queue.js              Persistent upload queue
  apps.js               Foreground app + website (Windows via koffi, macOS via osascript, Linux via xdotool)
  meeting.js            Microphone/camera in use (Windows registry)
  screenshots.js        Random-interval screenshots, 5-minute review, blur, upload outbox
  icons.js              Tray icons generated in code
  config.js             Local settings file (tracker-config.json)
  api.js                HTTP client (backend URL, timeouts)
test/
  tracker.test.js       Simulated-clock tests for the engine (npm test)
backend/
  server.js             Express app, security headers, v1 endpoints for old app versions
  device-api.js         /v2 desktop API (register, sync, me, adjustments, screenshots)
  admin-api.js          /admin page + /admin/api
  db.js                 Data layer, settings, daily summary
  storage.js            Screenshot storage, signed URLs, retention cleanup
  mailer.js             SMTP email
  public/               Admin console (admin.html, admin.css, admin.js)
  migrations.sql        Base tables (run first)
  migrations_003.sql    Everything else (includes migrations_002.sql)
.github/workflows/
  build.yml             Tag v* → build Windows/macOS/Linux installers → GitHub Release
  deploy-backend.yml    Push to master or a v* tag → trigger Render deploy
render.yaml             Render service definition (reference)
```

---

## Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 20 or newer | `node --version` |
| npm | comes with Node | `npm --version` |
| Git | any | `git --version` |
| Supabase project | free tier is fine | — |
| Gmail app password | optional, only for emails | — |

---

## Run everything locally

You need **three things running**: the database (Supabase, in the cloud), the backend on your PC, and the desktop app pointed at that backend.

### 1. Clone and install

```bash
git clone https://github.com/Jatinvaish/activitytracker.git
cd activitytracker
npm install
cd backend
npm install
cd ..
```

### 2. Prepare the database (once per Supabase project)

In the Supabase dashboard, open **SQL Editor → New query**, then run these files **in order**. Paste the whole file each time and click **Run**:

1. `backend/migrations.sql`: base tables (`users`, `sessions`, `adjustments`)
2. `backend/migrations_003.sql`: devices, live status, activity, apps, screenshots, projects, leave, settings, and row-level security

Both files are safe to run again.

### 3. Configure and start the backend

```powershell
# Windows PowerShell
cd backend
Copy-Item .env.example .env
notepad .env        # fill in API_SECRET, ADMIN_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY (SMTP optional)
node --env-file=.env server.js
```

```bash
# macOS / Linux
cd backend
cp .env.example .env
nano .env
node --env-file=.env server.js
```

You should see `Activity Tracker API running on port 3056`. For auto-restart while editing, use `node --watch --env-file=.env server.js`.

To generate random keys for `API_SECRET` and `ADMIN_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 4. Open the admin console

Go to **http://localhost:3056/admin** and sign in with your `ADMIN_KEY`.

### 5. Run the desktop app against your local backend

Open a **second terminal** in the project root. Three environment variables point the app at your backend and give it a separate test profile, so it never touches an installed copy:

| Variable | Purpose |
|---|---|
| `TRACKER_BACKEND_URL` | Backend to use (default: the production Render URL) |
| `TRACKER_API_SECRET` | Must equal `API_SECRET` in `backend/.env` |
| `TRACKER_USER_DATA` | Folder for this test profile (settings, queue, screenshots) |

```powershell
# Windows PowerShell (project root)
$env:TRACKER_BACKEND_URL = "http://localhost:3056"
$env:TRACKER_API_SECRET  = "paste the API_SECRET from backend/.env"
$env:TRACKER_USER_DATA   = "$PWD\.dev-profile"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # needed inside the VS Code terminal
npm start
```

```bash
# macOS / Linux (project root)
TRACKER_BACKEND_URL=http://localhost:3056 \
TRACKER_API_SECRET="paste the API_SECRET from backend/.env" \
TRACKER_USER_DATA="$PWD/.dev-profile" \
npm start
```

The name screen appears. Enter a test name such as `Test User`, accept the consent screen, and the window hides to the **system tray**. Click the coloured dot in the tray to open your dashboard.

When the app is not packaged (run with `npm start`), it does **not** add itself to Windows startup.

### 6. Start over with a fresh test profile

Quit the app first: right-click the tray dot, then **Quit**. Then delete the profile:

```powershell
Remove-Item -Recurse -Force .dev-profile     # Windows
```
```bash
rm -rf .dev-profile                           # macOS / Linux
```

To also remove the test employee from the database, open the admin console → **Employees** → **Delete**.

---

## Check that it works

All commands assume the backend runs on `http://localhost:3056`. In Windows PowerShell, type `curl.exe`, not `curl`, because plain `curl` is a PowerShell alias for a different command.

### Backend is up

```bash
curl http://localhost:3056/status
# {"status":"running","version":"1.0.0"}
```

### Database migration is applied

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" http://localhost:3056/admin/api/settings
# Good: {"defaults":{...},"global":{...}}
# Not applied yet: {"error":"The database needs an update. Run backend/migrations_003.sql ..."}
```

### Admin key works

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" http://localhost:3056/admin/api/ping
# {"ok":true}
```

### Desktop app registered and is sending data

After you finish setup in the app:

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" http://localhost:3056/admin/api/devices
# your computer with "status":"approved", "live_status":"active" (or idle), and a recent "last_seen_at"
```

In the app window's footer, look for **Synced just now**. In the admin console, the **Dashboard → Live now** panel should show you.

### Register and sync by hand (no desktop app)

Useful for testing the API itself.

**1. Register a fake computer.** `device_id` must be a new UUID; generate one with `node -e "console.log(crypto.randomUUID())"`.

```bash
curl -X POST http://localhost:3056/v2/register \
  -H "Content-Type: application/json" -H "x-api-secret: YOUR_API_SECRET" \
  -d '{"device_id":"PUT-A-UUID-HERE","name":"Curl Test","hostname":"MY-PC","platform":"win32","app_version":"dev","consent_version":1}'
# {"status":"approved","token":"...","user":{...}}
```

**2. Send one 10-minute active segment.** Use the token from step 1:

```bash
curl -X POST http://localhost:3056/v2/sync \
  -H "Content-Type: application/json" -H "Authorization: Bearer THE_TOKEN" \
  -d '{"client_now":"2026-10-24T10:00:00Z","segments":[{"client_id":"PUT-ANOTHER-UUID","start_time":"2026-10-24T09:50:00Z","end_time":"2026-10-24T10:00:00Z","status":"active","activity_pct":75}],"live":{"status":"active"}}'
# {"ok":true,"accepted":{"segments":1,...},"settings":{...}}
```

**3. See the day's summary.** This is what Attendance uses:

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" "http://localhost:3056/admin/api/summary?from=2026-10-24&to=2026-10-24"
```

Delete **Curl Test** from the admin console's Employees page afterwards.

### Things to try in the app

| Try this | Expected |
|---|---|
| Leave the PC untouched for 5 minutes | Status turns **Idle** (amber dot) |
| Come back after 10+ minutes idle | "Welcome back, what were you doing?" pop-up appears bottom-right |
| Lock the screen (Win + L), then unlock | That time shows as **Away** (grey), not idle |
| Join a call with mic on and don't type for 5+ minutes (Windows) | Stays **In a meeting** (blue) |
| Tray → Take a break → Lunch | Purple **At lunch**; the button becomes **End break** |
| Session list → **Request a change** → Send | Request shows in admin **Adjustments**; you get an email if SMTP is set |
| Approve it in the admin console | Desktop notification **Adjustment approved**; Requests tab shows it |
| Admin → Settings → Screenshots on, interval 5 | A screenshot card appears with **Delete** for 5 minutes, then uploads |
| Stop the backend, keep working, start it again | Footer says **Offline**; everything uploads once it's back |

---

## Tests

```bash
npm test
```

This runs `test/tracker.test.js`, which simulates hours of usage with a fake clock in plain Node (no Electron, no network). It covers:

- going idle and coming back (including the pop-up)
- meetings detected from the microphone
- lock and unlock
- sleep without warning
- splitting at midnight
- breaks and project switches
- crash recovery
- the upload queue

Syntax-check everything:

```bash
node --check main.js
node -e "for (const f of require('fs').readdirSync('app')) require('child_process').execFileSync(process.execPath, ['--check', 'app/' + f])"
node -e "for (const f of ['server','device-api','admin-api','db','storage','public/admin']) require('child_process').execFileSync(process.execPath, ['--check', 'backend/' + f + '.js'])"
```

---

## What gets tracked

| Status | When | Counts as |
|---|---|---|
| **Active** | Keyboard or mouse input within the idle threshold (default 5 min) | Worked |
| **Meeting** | No input, but the microphone or camera is in use (Windows); or the employee answered "Meeting" in the pop-up | Worked |
| **Idle** | No input for longer than the idle threshold | Idle |
| **Break / Lunch** | Employee pressed Take a break, or answered Break/Lunch in the pop-up | Break |
| **Away** | Screen locked, or the PC was asleep | Away |

- **Productivity** = worked ÷ (worked + idle).
- **Activity %**: of the seconds spent in Active, the share that had keyboard or mouse input. It's counted in 10-minute slots, and what was typed is never recorded.
- **Apps and sites**: the app in front, sampled every 5 s while active. For browsers it also records the site name taken from the window title.
- **Screenshots** are off by default. When turned on:
  - they're taken at a random moment in each interval, only while active
  - each is held on the PC for 5 minutes so the employee can delete it
  - they can be blurred
  - they're deleted after the retention period (default 30 days)
- **Late / half day / absent / overtime** (Attendance tab):
  - **Late**: first worked minute after shift start + grace.
  - **Half day**: worked less than 50% of the daily goal.
  - **Absent**: a past workday with no time, no leave and no holiday.
  - **Overtime**: worked minutes beyond the daily goal.

---

## Settings

Change these in **Admin → Settings** (company-wide) or per employee (**Employee → Settings**; blank = company default). Computers pick up changes on their next sync (≤ 2 minutes).

| Setting | Default | Range |
|---|---|---|
| `idle_threshold_mins` | 5 | 1–60 |
| `prompt_after_idle_mins` ("where were you?") | 10 | 0 = never, up to 240 |
| `daily_goal_mins` | 480 | 30–960 |
| `shift_start` / `shift_end` | 09:30 / 18:30 | HH:MM |
| `late_grace_mins` | 15 | 0–180 |
| `workdays` | Mon–Fri | 0 = Sun … 6 = Sat |
| `meeting_detection` | on | |
| `app_tracking` | on | |
| `screenshots_enabled` | off | |
| `screenshot_interval_mins` | 10 | 5–60 |
| `screenshot_blur` | off | |
| `screenshot_retention_days` | 30 | 1–365 |
| `end_of_day_summary` | on | notification at shift end |

### Backend environment variables

| Variable | Required | Notes |
|---|---|---|
| `API_SECRET` | yes | Shared key used only for `/v2/register` and the old v1 endpoints |
| `ADMIN_KEY` | yes | Admin console password; keep it different from `API_SECRET` |
| `SUPABASE_URL` | yes | `https://<project>.supabase.co` |
| `SUPABASE_SECRET_KEY` | yes | The **secret** key (`sb_secret_…`), not the publishable one |
| `APP_TIMEZONE` | no | Default `Asia/Kolkata` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | no | Emails go to `SMTP_USER`. The key is `SMTP_PASS`, not `SMTP_PASSWORD` |
| `PORT` | no | Render sets it; local default is 3056 |

---

## API reference

### Desktop API (`/v2`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v2/register` | `x-api-secret` | Register or re-register a computer; returns `approved` + token, `pending`, `rejected` or `revoked` |
| POST | `/v2/sync` | `Bearer <token>` | Upload segments, activity, apps and live status; returns settings, projects, decisions |
| GET | `/v2/me/sessions?from&to` | token | Employee's own sessions (≤ 93 days) |
| GET | `/v2/me/adjustments` | token | Employee's change requests |
| POST | `/v2/adjustments` | token | Request a change on a session |
| POST | `/v2/screenshots` | token | Upload a JPEG (refused if screenshots are off) |

The old endpoints `/session`, `/adjustment` and `/sessions/:username` stay for app versions ≤ 1.0.18.

### Admin API (`/admin/api`, header `x-admin-key`)

| Area | Endpoints |
|---|---|
| Employees | `GET /users`, `PATCH /users/:id` (name, settings), `POST /users/:id/merge`, `DELETE /users/:id` |
| Computers | `GET /devices[?user_id]`, `PATCH /devices/:id` (status, move to employee), `DELETE /devices/:id` |
| Sessions | `GET /sessions`, `POST /sessions`, `PATCH /sessions/:id`, `DELETE /sessions/:id` |
| Adjustments | `GET /adjustments`, `PATCH /adjustments/:id` (approve or reject, optional session fix) |
| Reports | `GET /summary?from&to` (daily totals + project time), `GET /activity`, `GET /apps` |
| Screenshots | `GET /screenshots`, `DELETE /screenshots/:id` |
| Setup | `GET/PUT /settings`, `GET/PUT/DELETE /app-categories`, `GET/POST/PATCH /projects` |
| Attendance | `GET /leaves?from&to`, `PUT /leaves`, `DELETE /leaves/:userId/:date`, `PUT /holidays`, `DELETE /holidays/:date` |

---

## Database

| Table | Holds |
|---|---|
| `users` | Employees (`name` is unique) and per-employee setting overrides |
| `devices` | One row per computer: status, token hash, live status, consent |
| `sessions` | Segments: start/end, status, category, project, activity %, live flag |
| `adjustments` | Change requests and the owner's decision |
| `activity_slots` | Active/total seconds per 10 minutes per computer |
| `app_usage` | Seconds per app (and site) per hour per computer |
| `app_categories` | Pattern → productive / neutral / unproductive |
| `screenshots` | Metadata; images live in the private Storage bucket `screenshots` |
| `projects` | Projects and clients |
| `leaves`, `holidays` | Attendance |
| `app_settings` | Company-wide settings |

Row-level security is enabled on every table with no policies, so only the backend's secret key can read or write.

---

## Build installers

Release builds run on GitHub Actions (see below). To build locally:

```bash
npm run build:win     # Windows .exe (NSIS)
npm run build:mac     # macOS .dmg (must run on a Mac)
npm run build:linux   # Linux .AppImage
```

**Windows note:** creating the NSIS installer locally needs **Developer Mode** (Settings → System → For developers), because electron-builder unpacks a tool that contains symbolic links. Without it, build just the unpacked app:

```bash
npx electron-builder --win dir --x64 --publish never
# result: dist/win-unpacked/Activity Tracker.exe
```

Check what ended up inside the app (it must contain only the app's own files, never `backend/` or any key file):

```bash
npx asar list "dist/win-unpacked/resources/app.asar" | grep -v node_modules
```

Check that the app-tracking native module loads from the packaged app:

```powershell
cd "dist\win-unpacked"
$env:ELECTRON_RUN_AS_NODE = "1"
& ".\Activity Tracker.exe" -e "require(process.cwd() + '/resources/app.asar/app/apps.js').sample().then(r => console.log(r))"
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

---

## Release and deploy

### Backend (Render)

- Pushing to `master` triggers `deploy-backend.yml`, which calls the Render deploy hook (`RENDER_DEPLOY_HOOK` secret).
- Environment variables are set in the Render dashboard. The service was created manually, so `render.yaml` is reference only.
- Run any new `migrations_*.sql` in Supabase **before** deploying code that needs it.

### Desktop app (GitHub Releases + auto-update)

1. Bump `"version"` in `package.json` (for example `1.0.19`).
2. Commit and push to `master`.
3. Tag and push:
   ```bash
   git tag v1.0.19
   git push origin v1.0.19
   ```
4. `build.yml` builds Windows (x64 + ia32), macOS (x64 + arm64) and Linux (x64) in parallel and publishes one GitHub Release with all installers and `latest*.yml`.
5. Installed apps check for updates at launch and every 4 hours. They download the update, close the current session cleanly, and restart into the new version.

Tags must always start with `v`. The latest release is at https://github.com/Jatinvaish/activitytracker/releases/latest.

### Uninstall

Uninstalling on Windows removes the app's data folder (`%APPDATA%\activity-utility`: saved name, upload queue, unsent screenshots). Auto-updates keep it.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm start` in the VS Code terminal opens no window, or fails with errors such as `Cannot read properties of undefined (reading 'setPath')` | VS Code sets `ELECTRON_RUN_AS_NODE=1`. Run `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) or `unset ELECTRON_RUN_AS_NODE` (bash) first |
| Admin console says "The database needs an update" | Run `backend/migrations_003.sql` in the Supabase SQL editor |
| App footer stays **Offline** | Backend unreachable. Check `TRACKER_BACKEND_URL` and that `/status` answers. Render's free plan can take up to a minute to wake |
| App says **Waiting for approval** | This is a second computer for that name. Approve it in Admin → Employees → that employee → Computers |
| App shows **This computer was removed** | The device was revoked in the admin console. Approve it again, then click **Check again** |
| Windows shows "Windows protected your PC" on install | The installer isn't code-signed. Click **More info → Run anyway**. Only a paid code-signing certificate removes this |
| No adjustment emails | Check the `SMTP_*` variables on Render; the key is `SMTP_PASS`. Requests are still saved and shown in the admin console |
| Screenshots don't show in the admin console | They're off by default (Admin → Settings). On macOS the app needs Screen Recording permission |
| Apps/sites empty on Linux | Install `xdotool` |

---

## Security and privacy

- **Desktop login:** each computer has its own token, and only its SHA-256 hash is stored. Revoking a computer invalidates its token immediately.
- **Shared key:** the `API_SECRET` built into the app can only register a computer. A second computer for an existing employee needs the owner's approval, so nobody can log time as someone else.
- **Admin access:** the admin console uses a separate `ADMIN_KEY`, compared in constant time. It is kept in the browser tab's session storage and cleared when the tab closes.
- **Database:** every table has row-level security on, and screenshots sit in a private bucket that is shown only through 1-hour signed links.
- **Employees see what's collected:** the consent screen lists exactly what is collected, and the version and time of consent are stored per computer.
- **Your control over capture:** app tracking and screenshots can be turned off per company or per employee, and the server refuses that data when they are off.
- **Never commit secrets:** that means `.env` files or the Google service-account JSON. `.gitignore` covers them, and the installer only packages the app's own files.
