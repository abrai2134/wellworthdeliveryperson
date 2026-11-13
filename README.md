# Well Worth – Delivery Helper & Installation Allocation

A small website that **picks the helpers and installation person for every machine delivery**, fairly, from all units.

- **Admin** adds the units, and each unit's **helpers** and **installation persons** (a person can also be *Helper + Installation*).
- **Unit** logs in and books a delivery: date, time (full day / morning / afternoon), **how many helpers** (usually 2–3) and **installation person needed: yes / no**. The team is picked straight away.
- **Shared equally across all units** – helpers are pooled from every unit. Whoever has done the fewest deliveries goes next, and people are rotated across the different units' deliveries.
- **More than one delivery a day** – each delivery gets its own team. Nobody is in two places at once: a *full day* delivery keeps the person all day, a *morning* and an *afternoon* delivery can share people.
- **Emergency backup person** – tick *Emergency backup* on a person and they are used only when the regular people run short. Any unit can also tap **🆘 Emergency person** on a delivery and pick anyone: free people (backup first) are listed at the top; a person on another unit's delivery can be moved, that unit is told and gets a free replacement if there is one.
- **Absent** – if a helper can't come, the unit (or admin) taps **Absent** and a new name is picked automatically; the rest of the team stays the same. Every absent is recorded on the job card (who, marked by, when, reason) so the admin can see it.
- **Leave** – admin marks leave; only that person's place is refilled.
- **Teams stay stable** – once a team is made it is not reshuffled. Admin can *Re-balance* from a date if wanted, and can change any person by hand (two people swap if needed).
- **Start / Completed** – the unit taps **▶ Start** when the team leaves and **✓ Completed** when the job is done. The team is then free straight away, and any other job that day that was short of people gets them automatically. Times are saved: *requested*, *started*, *completed*.
- **Time taken report** – average work time (start → completed) and total time (request → completed), for all jobs, deliveries, services and each unit, plus a list of every completed job. Jobs from earlier days that were never marked completed are flagged.
- **Service jobs** – book a 🔧 *Service* the same way as a delivery (service person = installation person, helpers optional). When marking a delivery completed you can choose *Service needed later: after 1 week / 15 days / 1 month / … / a date*, and the service is booked automatically with the same customer, address and machine. Completed jobs also have a **🔧 Book service** button.
- **Clients & machines from your Google Sheet** – when booking, type part of the party name, phone or city and pick the client; phone and address fill in by themselves. Add one line per machine model with its quantity (pick from your machine list or type a new one). The lists are copied from the sheet's *Party* and *Machines* tabs every 3 hours, or with *Sync now*. Set it up in **Admin → Clients & machines** (the Apps Script way keeps the sheet private; make it a **new, separate** Apps Script project so it does not touch any script already used with the sheet – the code is in `scripts/google-apps-script.gs`).
- **Service book photos** – when marking a job completed, take or choose photos of the service book page where the customer wrote remarks / signed (more photos can be added later with **📷 Add photo**). Photos are shrunk on the phone before upload, saved on the data disk in `uploads/`, and only the admin, that job's unit and its team can open them. *Download backup* does not include photos.
- **Expense per person** – worked out when a job is marked completed, from the work time (▶ Start → ✓ Completed). Deliveries: under 1 h nil, 1–3 h ₹35, 3–5 h ₹40, 5–6 h ₹55, 6 h and more ₹65. Services: under 3 h nil, 3–5 h ₹40, 5–6 h ₹55, 6 h and more ₹65. Both tables can be changed in *Settings*. Each person on the job gets the amount. If Start was not pressed the job is flagged and the times can be added. *Report → Expenses to pay* shows the total for each person; helpers see their month's expense when they log in.
- **Forgot to press Start / Completed?** The *Completed* box shows *Date*, *Start time* and *End time* (with a live expense preview) that can be changed. On a completed job without a start time the unit gets **🕒 Add times** (once; after that only the admin can change them). Typed-in times are marked "✎ times entered by …".
- **📦 Loading / Unloading** – internal work at a unit. The unit books it like a job (date, Morning / Afternoon / Evening – no full day, 1–4 persons). Helpers **and** installation persons of that unit are picked in turn by their own loading count (separate from deliveries), so the same people don't get tired; other units help only when the unit is short. The unit can mark someone **Absent** (a new person is picked automatically and it is recorded); only the admin can use Change / Emergency. No expense is paid. Start and end time are compulsory when completing, and the unit cannot book the next loading / unloading until the last one has its end time. The report shows each person's loading count.
- **🛠️ Assembly** – the admin adds **Team leaders** per unit (Helpers & installers → Work: *Team leader (assembly)*; give a PIN so they can log in). When machines come for assembly, the unit or admin enters *model no. + qty*; each machine goes to the unit's team leader whose team has the **fewest machines open (not started + assembling)** – a team that finished its work gets the next machines, however many it assembled before; machines not started yet move from a busy team to an idle one, with 1 installation person + 1 helper of the unit rotated fairly. A team leader with too many pending machines (default 6, *Assembly settings*) gets none – the machine waits and goes to the next free leader when someone finishes. Start and end date / time are compulsory. Team leaders can **request** a model and qty; machines are given only after the admin approves. Incentive per model for the team leader and the installation person (default amounts + per-model list). The **🏆 scoreboard** (assembled, pending, average time, incentive) is visible in every login. The admin can **add old machines** that were missed, with their times; team leaders can also send an old machine (📁 Add old machine) which counts after the admin approves. Only the admin can change people on a machine, but a team leader can **↪ Divert** a machine to another team leader of the unit (not full) – ₹100 per machine (setting) is deducted from the diverting leader's incentive; the scoreboard shows incentive, deduction and net. A **photo (JPG) of the machine sticker** is compulsory to mark a machine assembled; every assembled machine goes into **🏬 godown stock** – dispatch to a client is done only from the 🚚 Dispatch login (the admin can also mark a godown machine dispatched). Team leaders add old missed machines straight away (completed → end time and sticker photo compulsory, goes into godown stock; still assembling → it goes into their list). Waiting team-leader requests show as a red count on the admin Assembly tab and a banner on Today. Units switch between **🚚 Jobs** and **🛠️ Assembly** at the top of their page.
- **🏬 Godown & 🚚 Dispatch login** – assembled machines kept "in godown" are counted per unit and model (units see their own stock). The admin creates **Dispatch logins** (Assembly tab); the dispatch person logs in with the 🚚 Dispatch button, sees every unit's godown and sends machines (oldest first) to **another unit** (no incentive) or to a **client** (client name compulsory, from the party list). A dispatch to a client from a Dispatch login pays the **dispatch incentive** (per model, Assembly settings) to **that dispatch person**; they see their own total and a **dispatch scoreboard** in their login (the admin sees it too). Machines a dispatch person sends to the **Shilphata unit** (godown transfer) earn a **monthly bonus** by count: 1–10 ₹100, 11–20 ₹175, 21–30 ₹225, more than 30 ₹300. Transfers to other units do not count. Rates and the bonus unit(s) can be changed in *Assembly settings*. The dispatch scoreboard (Dispatch logins and admin) shows, for each person, client incentive and other-unit incentive in separate columns plus the total, which matches the person's own total at the top. Only the slab rates are admin only.  Admin dispatches pay nothing. Old stock already in a godown can be entered with **📦 Add stock** (Dispatch login, admin, or a unit for its own godown from its 🛠️ Assembly page – units add plain godown stock only; no assembly incentive) – choosing **Godown stock** or **Booked for a client** (party name compulsory) is compulsory; booked machines go first when dispatched to that party. A **dispatch photo** is compulsory whenever a machine leaves: sending from the Dispatch login (client or another unit) – the only way a machine goes to a client. The person who dispatched is recorded, so the history shows **By** and the **Photo**. History of the last 30 days is listed, with the photo. Each godown stock line also shows **who put the machines there and from which login** – 🛠️ assembled by a team leader, 📦 old stock added from a Unit / Dispatch / Admin login, or 🔁 transfer from another unit by a dispatch person.
- **🔎 Model no. search** – in every login (unit, team leader, dispatch, admin) the model box ignores `~`, spaces, brackets and capitals: typing **FT24BK** finds **FT~24BK (DUAL SUCTION POINT)**. If what was typed matches one machine of the list, the proper name is filled in and saved, so the same model is never counted under two names. Incentive rates match the same way.
- **Incentive rate compulsory** – a model no. can only be entered (machines for assembly, requests, old machines, old stock, model corrections) if it has an incentive rate in the assembly or dispatch list. A typing mistake like *T15CH3* for *TP150~CH3* gives an error at once. **Incentive is paid only for the exact model name** of the rate list (only capitals and spaces are ignored): a machine saved as *TP~150C2* or *TP150CH3* gets no incentive until its model is corrected to the exact name with ✎ Model. Picking from the list (or typing a name that clearly points to one machine) saves the exact name. Godown lines have **✎ Model** to correct a wrong model no.: admin and Dispatch logins on every line (assembled, transferred or old stock – the assembly incentive follows the corrected model), a unit only on old stock in its own godown.
- **✍️ Entry by** – every booking says who raised it. The names come from the **Made By** column of the sheet's *Order items* tab (tab and column can be changed in *Clients & machines*), so they always match the sheet. It is compulsory and starts empty on every new job, so each person picks their own name (unit logins are shared).
- **🔍 Search** – on the unit page and the admin *Deliveries* tab: search all jobs (any date) by party, model no., helper name, phone, address, notes, unit or date (24/10), and filter deliveries / services. Open a result or tap **🔧 Book service** from it.
- **Compact list** – completed jobs fold into one line each (customer, team, work time, expense); tap a line for the full card.
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
