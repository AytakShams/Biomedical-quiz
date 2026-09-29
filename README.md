# Spike or Subthreshold? — Bioelectricity Quiz

A 12-question bioelectricity quiz for a lecture hall. Project the QR code, students
scan it, type their name and answer on their phones; the lecturer watches scores land
live on their own laptop.

Practice mode: instant feedback after every answer, unlimited retries. Every attempt
is stored, and the panel shows each student's **best** score alongside their try count.

**Stack:** HTML + CSS + vanilla JS on the front, Node.js + SQLite on the back.
**Zero npm dependencies** — SQLite comes from Node's built-in `node:sqlite`, so there
is no `npm install`, no lockfile and no native build step.

```
Dockerfile          container: node:24-alpine, no build step
package.json        {"type":"module"} only — no dependencies
server.js           static files + JSON API + SQLite
public/
  index.html        student quiz (name entry -> 12 questions -> result)
  present.html      projector view: big QR code + live join counter
  admin.html        lecturer's live results panel
  quiz.css          shared design tokens and styles for all three pages
  questions.js      THE question bank — imported by the browser AND by server.js
  app.js            quiz flow + offline answer queue
  present.js, admin.js, qrcode.js
tools/loadtest.js   simulates a full class against a running server
```

---

## Three pages

| URL | Who | What |
|---|---|---|
| `/` | students | Name entry, then the quiz |
| `/present.html` | projector | Big QR code, live "N joined" counter, optional top 10 |
| `/admin.html` | lecturer | Live table, class accuracy, per-question stats, CSV export |

---

## Deploying on Coolify

> **Step 2 is not optional. Skip it and every `git push` erases the class results.**

1. **Build Pack → `Dockerfile`.** (The app was previously served as a static site; it
   now needs the container, because static hosting cannot write to a database.)

2. **Add Persistent Storage: a volume mounted at `/data`.**
   Mount the **directory**, not a single file — SQLite runs in WAL mode and writes
   `quiz.db-wal` and `quiz.db-shm` next to `quiz.db`. A single-file mount breaks WAL.

3. **Environment variables:**
   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a strong password — this is the only lock on the results panel |
   | `DB_PATH` | `/data/quiz.db` |
   | `PORT` | `3000` |

4. **Ports Exposes → `3000`**, so Traefik proxies to the right port.

5. **Attach the domain.** Coolify's generated address works too; Let's Encrypt is
   automatic. The QR code is generated from `location.origin`, so **changing the domain
   needs no code change.**

6. **Make sure no per-IP rate limiting is enabled.** All ~80 students arrive from the
   school's single NAT address; an IP-based limit would throttle the class.

7. `git push` to `main` deploys.

### Confirming the volume actually works

The server says so at boot. In Coolify's logs, look for:

```
  /data is a persistent mount - results survive redeploys.
```

If it instead says `/data is NOT a mount point … WILL BE LOST on the next redeploy`,
step 2 has not taken effect. Fix it before the lecture, not after.

---

## Running it locally

```bash
# Node 24+ (Node 22.5–23 also works, add --experimental-sqlite)
ADMIN_PASSWORD=test DB_PATH=./data/quiz.db PORT=3000 node server.js
```

Then open <http://localhost:3000>, <http://localhost:3000/present.html> and
<http://localhost:3000/admin.html>.

With Docker:

```bash
docker build -t quiz .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" -e ADMIN_PASSWORD=test quiz
```

### Load test

Proves a full class lands correctly, and that a replayed batch cannot double-count:

```bash
node tools/loadtest.js http://127.0.0.1:3000 <ADMIN_PASSWORD> 80 --replay
```

It checks every virtual student's server-side score against what they actually
answered, then cross-checks the lecturer's panel. It prints `PASS` or `FAIL`.

---

## Running it in class

1. Open `/admin.html` on your laptop and sign in. On the very first run this creates
   an open session automatically, labelled with today's date.
2. Project `/present.html`. Students scan, type their name, and start.
3. Watch the panel: names appear within ~3 seconds, `Progress` climbs as they answer.
4. Afterwards, **Export CSV** for your gradebook, and read the
   *"Which questions did the class miss?"* section to decide what to go over again.
5. **New session** starts a fresh list for the next class or next year (it closes the
   current one). **Close session** refuses new joins; students already mid-quiz can
   still finish and their answers still save.

Names are matched case- and spacing-insensitively with Turkish-aware folding, so
`AYŞE YILMAZ` and `Ayşe Yılmaz` are the same student. **Hide** removes a junk or
inappropriate name from the projector and from the counts, reversibly.

---

## Editing the quiz

Everything lives in `public/questions.js`. Append an object:

```js
{
  id: "saltatory-speed",        // stable, unique, never renamed or reused
  q: "…",
  correct: "…",
  wrong: ["…", "…", "…"],
  why: "…"                      // shown as feedback after answering
}
```

`git push` and Coolify redeploys. The browser and the server read the same file, so the
answer key cannot drift out of sync.

**`id` is written into the database.** Reordering questions is safe. Renaming an `id`
is not — old sessions' answers would stop lining up with the question they belong to.

---

## Why it is built this way

**The quiz runs offline once loaded.** Questions ship with the page, and answers go into
a `localStorage` queue that is flushed in batches with exponential-backoff retries. If
lecture-hall Wi-Fi drops for 30 seconds, the student notices nothing and no data is lost.

**Replaying an answer batch is harmless.** `answers` has `PRIMARY KEY (attempt_id, q_id)`
and inserts use `ON CONFLICT DO NOTHING`; scores are recomputed with `SUM(is_correct)`,
never incremented. This is what makes the retry queue safe.

**Scores cannot be forged.** The browser sends only the option text it tapped; `server.js`
grades it against its own copy of the key. In practice mode a curious student can read
the key from the page source, but they cannot submit a score.

**No WebSockets, no CDN, no external request.** The panel and the projector poll with
plain `fetch` over standard HTTPS on port 443, from a single origin. School proxies break
WebSockets routinely; polling works everywhere. Nothing is loaded from a third-party host,
so there is only one domain to whitelist if IT asks.

**Capacity.** 80 phones × 12 answers ≈ 960 tiny writes spread over ten minutes, about
1.6 requests per second. The load test runs 80 students in under a second on a laptop.
The real risk is the Wi-Fi, not the server — which is what the offline queue is for.

## Limits, deliberately

Practice mode with name-only sign-in is **not** exam-grade identification: a student can
type someone else's name, and can retry as often as they like. That was the chosen
trade-off. Turning this into a graded exam would need student numbers, one attempt per
student, and the answer key withheld from the browser.
