# Spike or Subthreshold? — Bioelectricity Quiz

A 12-question bioelectricity exam for a lecture hall, run like a quiz show. The lecturer
projects the board; students scan the QR code, type their name, and answer on their phones.
Everyone sees the same question at the same time, there are **15 seconds** per question,
and when it is over the **top three names appear on the board**.

**One attempt each.** A faster correct answer scores more, so the room has a reason to
look up and think quickly.

**Stack:** HTML + CSS + vanilla JS on the front, Node.js + SQLite on the back.
**Zero npm dependencies** — SQLite comes from Node's built-in `node:sqlite`, so there
is no `npm install`, no lockfile and no native build step.

```
Dockerfile          container: node:24-alpine, no build step
package.json        {"type":"module"} only — no dependencies
server.js           static files + JSON API + SQLite + the exam state machine
public/
  present.html      THE BOARD: QR code, the live question, the reveal, the podium
  index.html        student phone: name entry, then the answer pad
  admin.html        lecturer's results panel: table, per-question stats, CSV export
  quiz.css          shared design tokens and styles for all three pages
  questions.js      THE question bank — imported by the board AND by server.js
  app.js            the phone
  present.js        the board
  admin.js, qrcode.js
tools/loadtest.js   runs a whole exam with a simulated class and checks every number
```

---

## Three pages

| URL | Who | What |
|---|---|---|
| `/present.html` | **projector** | Signs in, then runs the exam: QR, question, reveal, podium |
| `/` | students | Name entry, then four answer buttons |
| `/admin.html` | lecturer | Live table, class accuracy, per-question stats, CSV export |

The board and the panel share one password, so signing into either signs you into both
for that browser.

---

## Running it in class

1. **Before class:** open `/present.html` on the podium laptop and sign in with
   `ADMIN_PASSWORD`. On the very first run this creates an open session automatically,
   labelled with today's date.
2. Project it. Students scan the QR code, type their name, and wait — their phones say
   *"Look up at the board."* The board counts them in and shows their names.
3. Press **Start the exam.** The question and its four options appear on the board; the
   phones show the same four options, labelled A–D, with no question text. The clock runs
   for 15 seconds whether or not everyone has answered.
4. When the clock runs out the board reveals the correct option, shows **how the class
   voted on each one**, and prints the explanation. Take as long as you like here — the
   exam waits. Press **Next question** when you are ready.
5. After the last question the board reveals the podium: third, second, then first, a beat
   apart, followed by the top ten.
6. Afterwards, **Export CSV** from `/admin.html` for your gradebook, and read
   *"Which questions did the class miss?"* to decide what to go over again.
7. **New session** starts a fresh list for the next class or next year (it closes the
   current one).

Names are matched case- and spacing-insensitively with Turkish-aware folding, so
`AYŞE YILMAZ` and `Ayşe Yılmaz` are the same student. **Hide** removes a junk or
inappropriate name from the board, the podium and the counts, reversibly.

### Scoring

| Outcome | Points |
|---|---|
| Correct | `1000 + 200 × (time left / 15s)` |
| Wrong | 0 |
| No answer | 0 |

So a correct answer in the first second is worth 1187, one at 14.9 seconds is worth 1001,
and the maximum for the whole exam is 14,400. **Knowledge decides the ranking; speed only
separates students who are otherwise level.** Ties go to the lower total answer time.

---

## Deploying on Coolify

> **Step 2 is not optional. Skip it and every `git push` erases the class results.**

1. **Build Pack → `Dockerfile`.** (The app was previously served as a static site; it
   needs the container, because static hosting cannot write to a database.)

2. **Add Persistent Storage: a volume mounted at `/data`.**
   Mount the **directory**, not a single file — SQLite runs in WAL mode and writes
   `quiz.db-wal` and `quiz.db-shm` next to `quiz.db`. A single-file mount breaks WAL.

3. **Environment variables:**
   | Name | Value |
   |---|---|
   | `ADMIN_PASSWORD` | a strong password — this is the only lock on the board and the panel |
   | `DB_PATH` | `/data/quiz.db` |
   | `PORT` | `3000` |
   | `QUESTION_MS` | *optional*, the per-question window in milliseconds (default `15000`) |

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
# Node 24+ (Node 22.5+ also works)
ADMIN_PASSWORD=test DB_PATH=./data/quiz.db PORT=3000 node server.js
```

Then open <http://localhost:3000/present.html> (the board) and <http://localhost:3000>
(a phone — narrow the window, or use your actual phone on the same Wi-Fi).

With Docker:

```bash
docker build -t quiz .
docker run --rm -p 3000:3000 -v "$PWD/data:/data" -e ADMIN_PASSWORD=test quiz
```

### Load test

Runs a whole exam with a simulated class — joining, answering, double-tapping, answering
too late, abstaining — and then checks every number the lecturer will see:

```bash
# a fast server for the test: 1.2s per question instead of 15s
ADMIN_PASSWORD=test QUESTION_MS=1200 DB_PATH=./data/test.db node server.js

node tools/loadtest.js http://127.0.0.1:3000 test 80
```

It proves, and prints `PASS` or `FAIL` on: every student's points and correct count
matching the panel, re-joining never granting a second attempt, a double tap never
rescoring, answers after the window being refused, an abstaining student ending on zero,
the per-option vote tally adding up, and the podium matching an independent ranking.
80 students and ~2,000 requests run in under a minute.

---

## Editing the quiz

Everything lives in `public/questions.js`. Append an object:

```js
{
  id: "saltatory-speed",        // stable, unique, never renamed or reused
  q: "…",
  correct: "…",
  wrong: ["…", "…", "…"],
  why: "…"                      // shown on the board at the reveal
}
```

`git push` and Coolify redeploys. The board and the server read the same file, so the
answer key cannot drift out of sync, and the option order is derived from the `id`, so
every screen in the room shows A–D in the same order.

**`id` is written into the database.** Reordering questions is safe. Renaming an `id`
is not — old sessions' answers would stop lining up with the question they belong to.

---

## Why it is built this way

**The server is the only clock, and the only referee.** The open session's row holds
`phase`, `q_index` and `q_started_at`; the board and every phone just read it and follow.
The 15-second window is closed by the server on the next read, not by the board's
countdown — so if the projector tab is backgrounded, reloaded or closed the exam carries
on, two open boards cannot skip a question, and an answer that arrives late is refused
even if nobody was watching. The lecturer is left with exactly two buttons.

**Phones are told the options, never the answer.** The phone receives the four option
texts of the live question only. There is no question bank and no answer key in anything
it downloads, and grading happens on the server from the submitted index. The question
itself stays on the board, which is the point: students have to look up.

**A double tap cannot score twice.** `answers` has `PRIMARY KEY (attempt_id, q_id)` and
inserts use `ON CONFLICT DO NOTHING`; totals are recomputed with `SUM()`, never
incremented. The first answer stands, and the phone is told what is actually stored.

**One attempt, without locking anyone out.** Joining with a name that is already in the
session hands back the *same* attempt. A reload, a flat battery or a second tab therefore
costs a student nothing — and buys them nothing either.

**Clocks are never trusted.** The server sends a remaining *duration*, never a timestamp,
so a phone or a laptop with a badly-set clock still counts down correctly, and every poll
re-anchors it.

**No WebSockets, no CDN, no external request.** The board polls once a second and phones
poll once a second during a question, with plain `fetch` over HTTPS from a single origin.
School proxies break WebSockets routinely; polling works everywhere.

**Capacity.** 80 phones polling once a second is ~80 tiny indexed reads per second, and
12 writes per student over the whole lecture. The load test runs 80 students through a
full exam in under a minute. The real risk is the Wi-Fi, not the server.

## Limits, deliberately

**Name-only sign-in is not exam-grade identification.** A student can clear their browser
storage and join again under a different name, or type a classmate's name. Making this
tamper-proof needs student numbers and a pre-registered roster. The mitigation in the room
is that joined names are visible on the board as they arrive, and **Hide** on the panel
takes a junk or duplicate entry out of the counts and the podium.

**Latecomers can still join** once the exam has started; they simply score nothing for
the questions they missed, which is its own penalty. Joining closes when the exam ends.

**There is no offline mode.** The old self-paced practice quiz queued answers in
`localStorage` and retried them for as long as it took. Under a hard 15-second deadline
that queue would deliver answers which can no longer score, promising points that never
arrive — so an answer is now posted immediately and retried only inside its own window.
A phone that drops off the Wi-Fi for a whole question loses that question.
