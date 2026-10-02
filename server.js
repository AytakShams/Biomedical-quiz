// Bioelectricity quiz server: static files + JSON API + SQLite. Zero npm dependencies.
//
// One synchronized exam, driven from the lecturer's board. The single source of truth for
// "where is the class right now" is the open session's row -- phase + q_index +
// q_started_at. Boards and phones only ever READ that and follow it; nobody advances on
// their own.
//
// Grading AND the clock live here, not in the browser. A phone sends the option INDEX it
// tapped; this file maps it through KEY from public/questions.js and measures elapsed time
// against q_started_at, so neither a tampered page nor a badly-set phone clock can buy
// points. The option texts go out to phones, but never which one is correct.
//
// Writes are idempotent: answers has PRIMARY KEY (attempt_id, q_id) and inserts use
// ON CONFLICT DO NOTHING, so a double tap or a retried request cannot score twice.
// Totals are always recomputed with SUM(), never incremented.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, sep, dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { QUESTIONS, KEY, QUIZ } from "./public/questions.js";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.error("node:sqlite is unavailable. Use Node 24+, or Node 22/23 with --experimental-sqlite.");
  process.exit(1);
}

const PORT     = Number(process.env.PORT || 3000);
const DB_PATH  = process.env.DB_PATH || "./data/quiz.db";
const ADMIN_PW = process.env.ADMIN_PASSWORD || "";
const PUBLIC   = resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const TOTAL    = QUESTIONS.length;
const MAX_BODY = 64 * 1024;
const MAX_STUDENTS_PER_SESSION = 500;   // soft guard; a real class is ~80

// The window every student gets, per question. Overridable so the load test can run a
// twelve-question exam in seconds -- and so the lecturer can retune the pace without a
// code change. The board and every phone read it from the server, never hard-code it.
const QUESTION_MS = Math.max(1000, Number(process.env.QUESTION_MS || 25000));
const GRACE_MS    = 1200;    // an answer already in flight when the clock hit 0 still counts
const BASE_POINTS = 1000;    // knowing the answer is worth this much whenever it lands
const SPEED_POINTS = 200;    // ...plus at most this much for being early

if (!ADMIN_PW) console.warn("! ADMIN_PASSWORD is not set - the board and results panel will refuse every login.");

/* ============================================================== database === */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous  = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT    NOT NULL,
    is_open      INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    phase        TEXT    NOT NULL DEFAULT 'lobby',   -- lobby | question | reveal | done
    q_index      INTEGER NOT NULL DEFAULT -1,
    q_started_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    name_key   TEXT    NOT NULL,
    hidden     INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    UNIQUE (session_id, name_key)
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    token       TEXT    NOT NULL UNIQUE,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    answered    INTEGER NOT NULL DEFAULT 0,
    score       INTEGER NOT NULL DEFAULT 0,   -- questions answered correctly
    points      INTEGER NOT NULL DEFAULT 0,   -- what the leaderboard ranks on
    total_ms    INTEGER NOT NULL DEFAULT 0,   -- tiebreaker: the faster class total wins
    total       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS answers (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    q_id       TEXT    NOT NULL,
    choice     TEXT    NOT NULL,              -- the option INDEX, "0".."3"
    is_correct INTEGER NOT NULL,
    points     INTEGER NOT NULL DEFAULT 0,
    ms         INTEGER,                       -- server-measured, from q_started_at
    at         INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, q_id)
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
  CREATE INDEX IF NOT EXISTS idx_students_session ON students(session_id);
`);

// The deployed database predates the synchronized exam, so add what is missing in place.
// ALTER TABLE ... ADD COLUMN is cheap and idempotent; running it on every boot keeps dev,
// Docker and production on one path with no migration files to track. Rows from the old
// practice quiz simply keep phase='lobby' and points=0 -- harmless history.
function addColumns(table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const [name, def] of Object.entries(columns)) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    console.log(`  migrated: ${table}.${name} added`);
  }
}
addColumns("sessions", {
  phase: "TEXT NOT NULL DEFAULT 'lobby'", q_index: "INTEGER NOT NULL DEFAULT -1", q_started_at: "INTEGER"
});
addColumns("attempts", { points: "INTEGER NOT NULL DEFAULT 0", total_ms: "INTEGER NOT NULL DEFAULT 0" });
addColumns("answers",  { points: "INTEGER NOT NULL DEFAULT 0" });

const q = {
  openSession:    db.prepare("SELECT * FROM sessions WHERE is_open=1 ORDER BY id DESC LIMIT 1"),
  latestSession:  db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1"),
  sessionById:    db.prepare("SELECT * FROM sessions WHERE id=?"),
  countSessions:  db.prepare("SELECT COUNT(*) AS c FROM sessions"),
  addSession:     db.prepare("INSERT INTO sessions (label,is_open,created_at) VALUES (?,1,?)"),
  closeAll:       db.prepare("UPDATE sessions SET is_open=0"),
  setOpen:        db.prepare("UPDATE sessions SET is_open=? WHERE id=?"),
  setPhase:       db.prepare("UPDATE sessions SET phase=?, q_index=?, q_started_at=? WHERE id=?"),
  sessionList:    db.prepare(`SELECT s.id, s.label, s.is_open, s.phase,
                                     (SELECT COUNT(*) FROM students WHERE session_id=s.id AND hidden=0) AS students
                                FROM sessions s ORDER BY s.id DESC`),
  sessionOfToken: db.prepare(`SELECT sess.* FROM sessions sess
                                JOIN students st ON st.session_id = sess.id
                                JOIN attempts a  ON a.student_id  = st.id
                               WHERE a.token=?`),

  addStudent:     db.prepare("INSERT OR IGNORE INTO students (session_id,name,name_key,first_seen) VALUES (?,?,?,?)"),
  touchName:      db.prepare("UPDATE students SET name=? WHERE session_id=? AND name_key=?"),
  findStudent:    db.prepare("SELECT * FROM students WHERE session_id=? AND name_key=?"),
  countStudents:  db.prepare("SELECT COUNT(*) AS c FROM students WHERE session_id=?"),
  setHidden:      db.prepare("UPDATE students SET hidden=? WHERE id=?"),
  names:          db.prepare("SELECT name FROM students WHERE session_id=? AND hidden=0 ORDER BY id DESC"),
  countJoined:    db.prepare("SELECT COUNT(*) AS c FROM students WHERE session_id=? AND hidden=0"),

  addAttempt:     db.prepare("INSERT INTO attempts (student_id,token,started_at,total) VALUES (?,?,?,?)"),
  attemptByToken: db.prepare("SELECT * FROM attempts WHERE token=?"),
  attemptById:    db.prepare("SELECT * FROM attempts WHERE id=?"),
  // One attempt per student, so the oldest row IS the attempt. Ordering by id keeps that
  // true even for a student who predates the one-attempt rule.
  attemptOf:      db.prepare("SELECT * FROM attempts WHERE student_id=? ORDER BY id LIMIT 1"),
  finishAll:      db.prepare(`UPDATE attempts SET finished_at=?
                               WHERE finished_at IS NULL
                                 AND student_id IN (SELECT id FROM students WHERE session_id=?)`),

  addAnswer:      db.prepare(`INSERT INTO answers (attempt_id,q_id,choice,is_correct,points,ms,at)
                              VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`),
  answerRow:      db.prepare("SELECT choice, is_correct, points FROM answers WHERE attempt_id=? AND q_id=?"),
  rescore:        db.prepare(`UPDATE attempts SET
                                score    = (SELECT COALESCE(SUM(is_correct),0) FROM answers WHERE attempt_id=?),
                                points   = (SELECT COALESCE(SUM(points),0)     FROM answers WHERE attempt_id=?),
                                answered = (SELECT COUNT(*)                    FROM answers WHERE attempt_id=?),
                                total_ms = (SELECT COALESCE(SUM(ms),0)         FROM answers WHERE attempt_id=?)
                              WHERE id=?`),

  countAnswered:  db.prepare(`SELECT COUNT(*) AS c FROM answers an
                                JOIN attempts a ON a.id = an.attempt_id
                                JOIN students s ON s.id = a.student_id
                               WHERE s.session_id=? AND s.hidden=0 AND an.q_id=?`),
  dist:           db.prepare(`SELECT an.choice AS c, COUNT(*) AS n FROM answers an
                                JOIN attempts a ON a.id = an.attempt_id
                                JOIN students s ON s.id = a.student_id
                               WHERE s.session_id=? AND s.hidden=0 AND an.q_id=?
                               GROUP BY an.choice`),

  // The leaderboard: points first, then the faster total time, then name so the order is
  // never arbitrary. Hidden students are out of the ranking entirely.
  leaderboard:    db.prepare(`SELECT s.id, s.name, a.points, a.score, a.total_ms
                                FROM students s JOIN attempts a ON a.student_id = s.id
                               WHERE s.session_id=? AND s.hidden=0
                               ORDER BY a.points DESC, a.total_ms ASC, s.name`),

  roster: db.prepare(`
    SELECT s.id, s.name, s.hidden, s.first_seen,
           COALESCE(a.points,0)   AS points,
           COALESCE(a.score,0)    AS score,
           COALESCE(a.answered,0) AS answered,
           a.finished_at,
           COALESCE((SELECT MAX(an.at) FROM answers an WHERE an.attempt_id = a.id), s.first_seen) AS seen
      FROM students s LEFT JOIN attempts a ON a.student_id = s.id
     WHERE s.session_id=? ORDER BY s.id`),

  qstats: db.prepare(`
    SELECT an.q_id AS id, COUNT(*) AS asked, SUM(an.is_correct) AS correct
      FROM answers an
      JOIN attempts a ON a.id = an.attempt_id
      JOIN students s ON s.id = a.student_id
     WHERE s.session_id=? AND s.hidden=0
     GROUP BY an.q_id`)
};

const now = () => Date.now();

// Knowledge first, speed only as a tiebreaker: a correct answer is worth BASE_POINTS
// whenever it lands inside the window, plus up to SPEED_POINTS for being early. A wrong
// answer and no answer at all are both worth nothing.
const pointsFor = (correct, elapsed) => correct
  ? BASE_POINTS + Math.round(SPEED_POINTS * Math.max(0, QUESTION_MS - elapsed) / QUESTION_MS)
  : 0;

function defaultLabel() {
  const d = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  return `${d} · ${QUIZ.id[0].toUpperCase()}${QUIZ.id.slice(1)}`;
}

function createSession(label) {
  q.closeAll.run();                       // only one session is ever open at a time
  const r = q.addSession.run(label || defaultLabel(), now());
  return q.sessionById.get(r.lastInsertRowid);
}

// Zero-config on day one, real control afterwards: auto-create only if no session has
// ever existed. Once the lecturer has closed a session, joining is genuinely refused.
function sessionForJoin() {
  const open = q.openSession.get();
  if (open) return open;
  if (q.countSessions.get().c === 0) return createSession(null);
  return null;
}

// Lazily close the window. The board's countdown is a display, not the clock: any read
// after the deadline moves the class on by itself. So a backgrounded or closed board tab
// cannot freeze the exam, two open boards cannot skip a question, and a late answer is
// refused even if nobody was looking at the projector.
function advance(session) {
  if (session && session.phase === "question" && now() - session.q_started_at > QUESTION_MS + GRACE_MS) {
    q.setPhase.run("reveal", session.q_index, session.q_started_at, session.id);
    return q.sessionById.get(session.id);
  }
  return session;
}
const liveSession = () => advance(q.openSession.get() || q.latestSession.get());
const remaining = s => s.phase === "question" ? Math.max(0, QUESTION_MS - (now() - s.q_started_at)) : 0;

// Turkish-aware folding so "AYŞE YILMAZ" and "Ayşe Yılmaz" are one student.
const normName = s => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 60);
const nameKey  = s => normName(s).toLocaleLowerCase("tr");

/* ================================================================= http === */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8"
};
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".txt"]);
const fileCache = new Map();   // path -> { body, gz, type }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error("body too large")); req.destroy(); return }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8"))) }
      catch { fail(new Error("bad json")) }
    });
    req.on("error", fail);
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = resolve(join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + sep)) { res.writeHead(403).end("Forbidden"); return }

  const ext = extname(file).toLowerCase();
  let entry = fileCache.get(file);
  if (!entry) {
    let body;
    try { body = await readFile(file) }
    catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found"); return }
    entry = {
      body,
      type: MIME[ext] || "application/octet-stream",
      gz: COMPRESSIBLE.has(ext) && body.length > 1024 ? gzipSync(body, { level: 6 }) : null
    };
    fileCache.set(file, entry);
  }

  const wantsGz = entry.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const payload = wantsGz ? entry.gz : entry.body;
  const head = {
    "Content-Type": entry.type,
    "Content-Length": payload.length,
    // The class must never be served yesterday's build; payloads are tiny anyway.
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  };
  if (wantsGz) { head["Content-Encoding"] = "gzip"; head.Vary = "Accept-Encoding" }
  res.writeHead(200, head);
  res.end(req.method === "HEAD" ? undefined : payload);
}

/* ================================================================= auth === */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function authed(req) {
  if (!ADMIN_PW) return false;
  const h = req.headers.authorization || "";
  const got = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(got), b = Buffer.from(ADMIN_PW);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ================================================================ board === */
// Everything the projector needs, in one small payload. Nothing here gives away a live
// answer: correctIndex appears only once the class has moved on to the reveal.
function boardState() {
  const session = liveSession();
  if (!session) return { phase: "lobby", qIndex: -1, total: TOTAL, joined: 0, names: [], answeredCount: 0 };

  const out = {
    phase: session.phase,
    qIndex: session.q_index,
    total: TOTAL,
    label: session.label,
    isOpen: !!session.is_open,
    remainingMs: remaining(session),
    questionMs: QUESTION_MS,
    joined: q.countJoined.get(session.id).c,
    answeredCount: 0
  };

  if (session.phase === "lobby") out.names = q.names.all(session.id).slice(0, 40).map(r => r.name);

  if (session.q_index >= 0 && session.q_index < TOTAL) {
    const id = QUESTIONS[session.q_index].id;
    out.answeredCount = q.countAnswered.get(session.id, id).c;
    if (session.phase === "reveal") {
      out.correctIndex = KEY.get(id).correct;
      out.dist = [0, 0, 0, 0];
      for (const r of q.dist.all(session.id, id)) {
        const c = Number(r.c);
        if (c >= 0 && c < 4) out.dist[c] = r.n;
      }
    }
  }

  if (session.phase === "done") {
    const rows = q.leaderboard.all(session.id);
    const place = r => ({ name: r.name, points: r.points, correct: r.score });
    // Nobody stands on the podium for scoring zero -- in a small or quiet class that
    // would put a student who never answered in third place.
    out.podium  = rows.filter(r => r.points > 0).slice(0, 3).map(place);
    out.leaders = rows.slice(0, 10).map(place);
  }
  return out;
}

/* =============================================================== routes === */
async function api(req, res, url) {
  const p = url.pathname;

  /* ---- student: join (or resume) ---------------------------------------- */
  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const name = normName(body.name);
    if (name.length < 2) return send(res, 400, { error: "name too short" });

    const session = sessionForJoin();
    if (!session) return send(res, 409, { error: "closed" });
    if (session.phase === "done") return send(res, 409, { error: "finished" });

    const key = nameKey(name);
    let student = q.findStudent.get(session.id, key);
    if (!student) {
      if (q.countStudents.get(session.id).c >= MAX_STUDENTS_PER_SESSION)
        return send(res, 429, { error: "session full" });
      q.addStudent.run(session.id, name, key, now());
      student = q.findStudent.get(session.id, key);
    } else if (student.name !== name) {
      q.touchName.run(name, session.id, key);   // keep the latest spelling they typed
    }

    // One go at the exam, per student, per session. A reload, a locked phone or a second
    // tab resumes the SAME attempt instead of opening a fresh one -- that is what makes
    // the single-attempt rule hold without locking anyone out of their own answers.
    let attempt = q.attemptOf.get(student.id);
    if (!attempt) {
      q.addAttempt.run(student.id, randomBytes(16).toString("hex"), now(), TOTAL);
      attempt = q.attemptOf.get(student.id);
    }
    return send(res, 200, { token: attempt.token, name, sessionLabel: session.label, total: TOTAL });
  }

  /* ---- student: what should my phone show right now? -------------------- */
  if (p === "/api/state" && req.method === "GET") {
    const token = url.searchParams.get("token") || "";
    const attempt = q.attemptByToken.get(token);
    if (!attempt) return send(res, 404, { error: "unknown attempt" });
    const session = advance(q.sessionOfToken.get(token));

    const fresh = q.attemptById.get(attempt.id);
    const out = {
      phase: session.phase,
      qIndex: session.q_index,
      questionNo: session.q_index + 1,
      total: TOTAL,
      remainingMs: remaining(session),
      questionMs: QUESTION_MS,
      myPoints: fresh.points,
      myCorrect: fresh.score
    };

    if (session.q_index >= 0 && session.q_index < TOTAL &&
       (session.phase === "question" || session.phase === "reveal")) {
      const question = QUESTIONS[session.q_index];
      const key = KEY.get(question.id);
      // The option TEXTS go to the phone so it can show real choices, but never which one
      // is right: the key stays on the server and the lecturer's board, so the page source
      // a student can read holds no answers at all.
      out.options = key.options;
      const mine = q.answerRow.get(attempt.id, question.id);
      out.answered = !!mine;
      out.myChoice = mine ? Number(mine.choice) : null;
      if (session.phase === "reveal") {
        out.correctIndex = key.correct;
        out.wasCorrect = mine ? !!mine.is_correct : false;
        out.earned = mine ? mine.points : 0;
      }
    }

    if (session.phase === "reveal" || session.phase === "done") {
      const rows = q.leaderboard.all(session.id);
      const k = rows.findIndex(r => r.id === attempt.student_id);
      out.myRank = k >= 0 ? k + 1 : null;
      out.ranked = rows.length;
    }
    return send(res, 200, out);
  }

  /* ---- student: answer the live question -------------------------------- */
  if (p === "/api/answer" && req.method === "POST") {
    const body = await readBody(req);
    const token = String(body.token || "");
    const attempt = q.attemptByToken.get(token);
    if (!attempt) return send(res, 404, { error: "unknown attempt" });

    const session = advance(q.sessionOfToken.get(token));
    const choice = Number(body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 3)
      return send(res, 400, { error: "bad choice" });
    // The phone must say WHICH question it is answering. Without that, a tap that was in
    // flight across a phase change would land on the next question.
    if (session.phase !== "question" || Number(body.qIndex) !== session.q_index)
      return send(res, 409, { error: "not the live question" });

    const question = QUESTIONS[session.q_index];
    const elapsed = Math.max(0, now() - session.q_started_at);
    const correct = choice === KEY.get(question.id).correct;

    q.addAnswer.run(attempt.id, question.id, String(choice),
                    correct ? 1 : 0, pointsFor(correct, elapsed), elapsed, now());
    q.rescore.run(attempt.id, attempt.id, attempt.id, attempt.id, attempt.id);

    // ON CONFLICT DO NOTHING means the FIRST answer stands. Read back what is actually
    // stored, so a double tap is told the truth rather than the score it hoped for.
    const stored = q.answerRow.get(attempt.id, question.id);
    return send(res, 200, {
      locked: true, qIndex: session.q_index,
      choice: Number(stored.choice), correct: !!stored.is_correct, points: stored.points
    });
  }

  /* ---- projector board (display only; the controls below need the password) */
  if (p === "/api/board" && req.method === "GET") return send(res, 200, boardState());

  /* ---- admin ------------------------------------------------------------ */
  if (p.startsWith("/api/admin/")) {
    if (!authed(req)) { await sleep(300); return send(res, 401, { error: "unauthorized" }) }

    const pick = () => {
      const id = url.searchParams.get("session");
      return (id && q.sessionById.get(Number(id)))
          || q.openSession.get() || q.latestSession.get() || createSession(null);
    };

    /* the two buttons that drive the exam, pressed from the board */
    if (p === "/api/admin/control" && req.method === "POST") {
      const b = await readBody(req);
      const session = liveSession() || createSession(null);

      if (b.action === "start" && session.phase === "lobby") {
        q.setPhase.run("question", 0, now(), session.id);
      } else if (b.action === "next" && session.phase === "reveal") {
        const next = session.q_index + 1;
        if (next < TOTAL) {
          q.setPhase.run("question", next, now(), session.id);
        } else {
          q.setPhase.run("done", session.q_index, null, session.id);
          q.finishAll.run(now(), session.id);   // the exam is over for everyone at once
        }
      }
      // Anything else -- a double-click, a second board tab, an action that does not fit
      // the current phase -- is a no-op that simply reports where the class really is.
      return send(res, 200, boardState());
    }

    if (p === "/api/admin/live" && req.method === "GET") {
      const session = pick();
      const stats = new Map(q.qstats.all(session.id).map(r => [r.id, r]));
      return send(res, 200, {
        session:  { id: session.id, label: session.label, is_open: !!session.is_open, phase: session.phase },
        sessions: q.sessionList.all().map(s => ({ ...s, is_open: !!s.is_open })),
        total: TOTAL,
        students: q.roster.all(session.id).map(s => ({
          id: s.id, name: s.name, hidden: !!s.hidden,
          points: s.points, correct: s.score, answered: s.answered,
          finished: !!s.finished_at, seen: s.seen || s.first_seen
        })),
        questions: QUESTIONS.map(qq => {
          const r = stats.get(qq.id) || { asked: 0, correct: 0 };
          return {
            id: qq.id, asked: r.asked, correct: r.correct,
            pct: r.asked ? Math.round(r.correct / r.asked * 100) : 0
          };
        })
      });
    }

    if (p === "/api/admin/session" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action === "create") return send(res, 200, { id: createSession(normName(b.label)).id });
      if (b.action === "close")  { q.setOpen.run(0, Number(b.id)); return send(res, 200, { ok: true }) }
      if (b.action === "open")   { q.closeAll.run(); q.setOpen.run(1, Number(b.id)); return send(res, 200, { ok: true }) }
      return send(res, 400, { error: "bad action" });
    }

    if (p === "/api/admin/student" && req.method === "POST") {
      const b = await readBody(req);
      if (b.action !== "hide" && b.action !== "show") return send(res, 400, { error: "bad action" });
      q.setHidden.run(b.action === "hide" ? 1 : 0, Number(b.id));
      return send(res, 200, { ok: true });
    }

    if (p === "/api/admin/export.csv" && req.method === "GET") {
      const session = pick();
      const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const iso  = t => t ? new Date(t).toISOString() : "";
      const rank = new Map(q.leaderboard.all(session.id).map((r, i) => [r.id, i + 1]));
      const lines = [["Rank", "Name", "Points", "Correct", "Total", "Answered", "Finished",
                      "First seen", "Last seen", "Hidden"].map(cell).join(",")];
      for (const s of q.roster.all(session.id)) {
        lines.push([rank.get(s.id) || "", s.name, s.points, s.score, TOTAL, s.answered,
                    s.finished_at ? "yes" : "no", iso(s.first_seen), iso(s.seen), s.hidden ? "yes" : "no"]
                   .map(cell).join(","));
      }
      const csv = "﻿" + lines.join("\r\n") + "\r\n";   // BOM so Excel reads UTF-8
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Length": Buffer.byteLength(csv),
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="quiz-results-${session.id}.csv"`
      });
      return res.end(csv);
    }
  }

  return send(res, 404, { error: "not found" });
}

/* ================================================================ server === */
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      return res.end("ok");
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, url.pathname);
    res.writeHead(405, { "Cache-Control": "no-store" }).end("Method not allowed");
  } catch (err) {
    console.error(req.method, url.pathname, "->", err.message);
    if (!res.headersSent) send(res, 500, { error: "server error" });
    else res.end();
  }
}).listen(PORT, async () => {
  console.log(`quiz server on :${PORT}  db=${DB_PATH}  questions=${TOTAL}  ${QUESTION_MS / 1000}s/question  admin=${ADMIN_PW ? "set" : "NOT SET"}`);
  await reportPersistence();
});

// Losing the database to a redeploy is the one mistake that cannot be undone after a
// lecture, so say it out loud at boot instead of letting it be discovered later.
// /proc/mounts exists inside Linux containers; on a dev Mac this simply stays quiet.
async function reportPersistence() {
  const dir = dirname(resolve(DB_PATH));
  let mounts;
  try { mounts = await readFile("/proc/mounts", "utf8") } catch { return }
  const isMount = mounts.split("\n").some(l => l.split(" ")[1] === dir);
  console.log(isMount
    ? `  ${dir} is a persistent mount - results survive redeploys.`
    : `! ${dir} is NOT a mount point. The database lives in the container filesystem and\n`
    + `  WILL BE LOST on the next redeploy. Add persistent storage mounted at ${dir}.`);
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { try { db.close() } catch {} process.exit(0) });
}
