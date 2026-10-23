# Well Worth – Delivery Helper & Installation Allocation

A small website that **picks the helpers and installation person for every machine delivery**, fairly, from all units.

- **Admin** adds the units, and each unit's **helpers** and **installation persons** (a person can also be *Helper + Installation*).
- **Unit** logs in and books a delivery: date, time (full day / morning / afternoon), **how many helpers** (usually 2–3) and **installation person needed: yes / no**. The team is picked straight away.
- **Shared equally across all units** – helpers are pooled from every unit. Whoever has done the fewest deliveries goes next, and people are rotated across the different units' deliveries.
- **More than one delivery a day** – each delivery gets its own team. Nobody is in two places at once: a *full day* delivery keeps the person all day, a *morning* and an *afternoon* delivery can share people.
- **Emergency backup person** – tick *Emergency backup* on a person and they are used only when the regular people run short. Any unit can also tap **🆘 Emergency person** on a delivery and pick anyone: free people (backup first) are listed at the top; a person on another unit's delivery can be moved, that unit is told and gets a free replacement if there is one.
- **Absent – replace** – if a helper can't come, the unit taps it and someone else is picked automatically. The rest of the team stays the same.
- **Leave** – admin marks leave; only that person's place is refilled.
- **Teams stay stable** – once a team is made it is not reshuffled. Admin can *Re-balance* from a date if wanted, and can change any person by hand (two people swap if needed).
- **WhatsApp** button on every delivery to share the team list, **Fairness report** for the admin.

## Three logins

| Login | Who | What they see |
|-------|-----|---------------|
| **Admin** | You | Today's deliveries, all deliveries, units, helpers & installers, leave, fairness report, settings, backup |
| **Unit** | Each unit's person | Book / edit / cancel deliveries, see the team with **Call** buttons, 🆘 emergency person, absent – replace |
| **Helper** | Helpers / installation persons (optional) | Today's delivery (unit, customer, address, **Map**, team) and the next ones |

The admin creates the login ID and password for every unit. A helper only gets a login if the admin gives them a PIN.

## Try it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm run demo     # optional: adds 4 sample units with helpers and installers
npm start        # open http://localhost:3000
```

First login: **admin / admin123**. Change it straight away in *Settings*.

Demo logins (only if you ran `npm run demo`): units `unit1`/`unit1` … `unit4`/`unit4`, helpers `9930000001`/`1234` …

## Put it online

The app saves everything in one file, `db.json`, inside the data folder (`DATA_DIR`). Online, that folder **must be on a persistent disk**, or the data is lost when the server restarts.

### Option A – Render (easiest)
1. Create an account at [render.com](https://render.com) and connect your GitHub.
2. *New → Blueprint* → pick this repository. Render reads `render.yaml` (web service + 1 GB disk; the disk needs the paid *Starter* plan).
3. Set `ADMIN_PASSWORD` when asked. Deploy.
4. Share the `https://….onrender.com` link with your units.

### Option B – Railway
1. [railway.app](https://railway.app) → *New project → Deploy from GitHub repo*.
2. Add a **Volume** mounted at `/data`, and the variable `DATA_DIR=/data`.
3. Set `ADMIN_PASSWORD`. Under *Settings → Networking* click *Generate domain* and share the link.

### Option C – Any VPS / your own server (Docker)
```bash
docker build -t delivery-team .
docker run -d -p 80:3000 -v delivery-data:/data -e ADMIN_PASSWORD=choose-a-strong-one delivery-team
```

### Settings (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Web port |
| `DATA_DIR` | `./data` | Folder where `db.json` is saved |
| `ADMIN_USERNAME` | `admin` | First admin username (only used on first start) |
| `ADMIN_PASSWORD` | `admin123` | First admin password (only used on first start) |

**Backups:** *Settings → Download backup* saves everything to a file; *Restore from file* loads it back.

## How the allocation works

For each delivery, the open places (installation person first, then helper 1, 2, 3 …) are matched to free people with the Hungarian algorithm (the optimal assignment). The score, in order of importance:

1. fill every place – the installation place and helper 1 are kept before helper 3 when people are short,
2. use regular people first; emergency backup people only when regulars run out,
3. give the work to whoever has done the fewest deliveries (counted over all dates, so booking in any order is still fair),
4. send people to the units whose deliveries they have joined least (shuffle across units),
5. prefer whoever has rested longest, then a small shuffle for ties.

A new person starts level with the others, so they are not flooded with work to catch up. Past deliveries are never changed.

## Development

```bash
npm test
```

Code layout: `server.js` (web server and API), `lib/scheduler.js` (allocation), `lib/store.js` (JSON file storage), `lib/auth.js` (passwords and login sessions), `public/` (the web pages).
