// Bioelectricity quiz server: static files + JSON API + SQLite. Zero npm dependencies.
//
// Grading lives here, not in the browser. The client sends the option TEXT it tapped;
// this file compares it against ANSWER_KEY from public/questions.js -- the same file the
// browser imported -- so a student can read the key but cannot forge a score.
//
// Writes are idempotent: answers has PRIMARY KEY (attempt_id, q_id) and inserts use
// ON CONFLICT DO NOTHING, so the client's retry queue can replay a batch safely.
// Scores are always recomputed with SUM(is_correct), never incremented.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, sep, dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { QUESTIONS, ANSWER_KEY, QUIZ } from "./public/questions.js";

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

if (!ADMIN_PW) console.warn("! ADMIN_PASSWORD is not set - the results panel will refuse every login.");

/* ============================================================== database === */
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous  = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    label      TEXT    NOT NULL,
    is_open    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
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
    score       INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS answers (
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    q_id       TEXT    NOT NULL,
    choice     TEXT    NOT NULL,
    is_correct INTEGER NOT NULL,
    ms         INTEGER,
    at         INTEGER NOT NULL,
    PRIMARY KEY (attempt_id, q_id)
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_student ON attempts(student_id);
  CREATE INDEX IF NOT EXISTS idx_students_session ON students(session_id);
`);

const q = {
  openSession:    db.prepare("SELECT * FROM sessions WHERE is_open=1 ORDER BY id DESC LIMIT 1"),
  latestSession:  db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1"),
  sessionById:    db.prepare("SELECT * FROM sessions WHERE id=?"),
  countSessions:  db.prepare("SELECT COUNT(*) AS c FROM sessions"),
  addSession:     db.prepare("INSERT INTO sessions (label,is_open,created_at) VALUES (?,1,?)"),
  closeAll:       db.prepare("UPDATE sessions SET is_open=0"),
  setOpen:        db.prepare("UPDATE sessions SET is_open=? WHERE id=?"),
  sessionList:    db.prepare(`SELECT s.id, s.label, s.is_open,
                                     (SELECT COUNT(*) FROM students WHERE session_id=s.id AND hidden=0) AS students
                                FROM sessions s ORDER BY s.id DESC`),

  addStudent:     db.prepare("INSERT OR IGNORE INTO students (session_id,name,name_key,first_seen) VALUES (?,?,?,?)"),
  touchName:      db.prepare("UPDATE students SET name=? WHERE session_id=? AND name_key=?"),
  findStudent:    db.prepare("SELECT * FROM students WHERE session_id=? AND name_key=?"),
  countStudents:  db.prepare("SELECT COUNT(*) AS c FROM students WHERE session_id=?"),
  setHidden:      db.prepare("UPDATE students SET hidden=? WHERE id=?"),

  addAttempt:     db.prepare("INSERT INTO attempts (student_id,token,started_at,total) VALUES (?,?,?,?)"),
  attemptByToken: db.prepare("SELECT * FROM attempts WHERE token=?"),
  addAnswer:      db.prepare(`INSERT INTO answers (attempt_id,q_id,choice,is_correct,ms,at)
                              VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`),
  rescore:        db.prepare(`UPDATE attempts SET
                                score    = (SELECT COALESCE(SUM(is_correct),0) FROM answers WHERE attempt_id=?),
                                answered = (SELECT COUNT(*)                    FROM answers WHERE attempt_id=?)
                              WHERE id=?`),
  finish:         db.prepare("UPDATE attempts SET finished_at=? WHERE id=? AND finished_at IS NULL"),
  attemptById:    db.prepare("SELECT * FROM attempts WHERE id=?"),

  roster: db.prepare(`
    SELECT s.id, s.name, s.hidden, s.first_seen,
           (SELECT COUNT(*)              FROM attempts WHERE student_id=s.id)                        AS attempts,
           (SELECT COALESCE(MAX(score),0) FROM attempts WHERE student_id=s.id)                       AS best,
           (SELECT COALESCE(score,0)     FROM attempts WHERE student_id=s.id ORDER BY id DESC LIMIT 1) AS last,
           (SELECT COALESCE(answered,0)  FROM attempts WHERE student_id=s.id ORDER BY id DESC LIMIT 1) AS answered,
           (SELECT COUNT(*)              FROM attempts WHERE student_id=s.id AND finished_at IS NOT NULL) AS dones,
           (SELECT finished_at           FROM attempts WHERE student_id=s.id ORDER BY id DESC LIMIT 1)    AS last_finished,
           (SELECT MAX(v) FROM (
              SELECT MAX(started_at) AS v FROM attempts WHERE student_id=s.id
              UNION ALL
              SELECT MAX(an.at)      AS v FROM answers an
                JOIN attempts a2 ON a2.id=an.attempt_id WHERE a2.student_id=s.id
           ))                                                                                        AS seen
      FROM students s WHERE s.session_id=? ORDER BY s.id`),

  qstats: db.prepare(`
    SELECT an.q_id AS id, COUNT(*) AS asked, SUM(an.is_correct) AS correct
      FROM answers an
      JOIN attempts a ON a.id = an.attempt_id
      JOIN students s ON s.id = a.student_id
     WHERE s.session_id=? AND s.hidden=0
     GROUP BY an.q_id`)
};

const now = () => Date.now();

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

/* =============================================================== routes === */
async function api(req, res, url) {
  const p = url.pathname;

  /* ---- student: join ---------------------------------------------------- */
  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const name = normName(body.name);
    if (name.length < 2) return send(res, 400, { error: "name too short" });

    const session = sessionForJoin();
    if (!session) return send(res, 409, { error: "closed" });

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

    const token = randomBytes(16).toString("hex");
    q.addAttempt.run(student.id, token, now(), TOTAL);
    return send(res, 200, { token, name, sessionLabel: session.label, total: TOTAL });
  }

  /* ---- student: batch of answers ---------------------------------------- */
  if (p === "/api/answers" && req.method === "POST") {
    const body = await readBody(req);
    const attempt = q.attemptByToken.get(String(body.token || ""));
    if (!attempt) return send(res, 404, { error: "unknown attempt" });

    const list = Array.isArray(body.answers) ? body.answers.slice(0, TOTAL * 2) : [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const a of list) {
        const key = ANSWER_KEY.get(String(a.qId));
        if (key === undefined) continue;                 // unknown question id: ignore
        const choice = String(a.choice ?? "").slice(0, 400);
        const ms = Number.isFinite(+a.ms) ? Math.max(0, Math.min(3600000, +a.ms)) : null;
        // `at` comes from the phone's clock; a badly-set clock must not poison "last seen".
        const t = now(), raw = +a.at;
        const at = Number.isFinite(raw) && raw > t - 7 * 86400000 && raw < t + 60000 ? raw : t;
        q.addAnswer.run(attempt.id, String(a.qId), choice, choice === key ? 1 : 0, ms, at);
      }
      q.rescore.run(attempt.id, attempt.id, attempt.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    const fresh = q.attemptById.get(attempt.id);
    return send(res, 200, { score: fresh.score, answered: fresh.answered });
  }

  /* ---- student: finish -------------------------------------------------- */
  if (p === "/api/finish" && req.method === "POST") {
    const body = await readBody(req);
    const attempt = q.attemptByToken.get(String(body.token || ""));
    if (!attempt) return send(res, 404, { error: "unknown attempt" });
    q.rescore.run(attempt.id, attempt.id, attempt.id);
    q.finish.run(now(), attempt.id);
    const fresh = q.attemptById.get(attempt.id);
    return send(res, 200, { score: fresh.score, answered: fresh.answered, total: TOTAL });
  }

  /* ---- projector board (public, minimal) -------------------------------- */
  if (p === "/api/board" && req.method === "GET") {
    const session = q.openSession.get() || q.latestSession.get();
    if (!session) return send(res, 200, { joined: 0, finished: 0, top: [] });
    const roster = q.roster.all(session.id).filter(s => !s.hidden);
    return send(res, 200, {
      joined: roster.length,
      finished: roster.filter(s => s.dones > 0).length,
      top: roster.filter(s => s.attempts > 0)
                 .sort((a, b) => b.best - a.best || a.seen - b.seen)
                 .slice(0, 10)
                 .map(s => ({ name: s.name, score: s.best, total: TOTAL }))
    });
  }

  /* ---- admin ------------------------------------------------------------ */
  if (p.startsWith("/api/admin/")) {
    if (!authed(req)) { await sleep(300); return send(res, 401, { error: "unauthorized" }) }

    const pick = () => {
      const id = url.searchParams.get("session");
      return (id && q.sessionById.get(Number(id)))
          || q.openSession.get() || q.latestSession.get() || createSession(null);
    };

    if (p === "/api/admin/live" && req.method === "GET") {
      const session = pick();
      const stats = new Map(q.qstats.all(session.id).map(r => [r.id, r]));
      return send(res, 200, {
        session:  { id: session.id, label: session.label, is_open: !!session.is_open },
        sessions: q.sessionList.all().map(s => ({ ...s, is_open: !!s.is_open })),
        total: TOTAL,
        students: q.roster.all(session.id).map(s => ({
          id: s.id, name: s.name, hidden: !!s.hidden,
          attempts: s.attempts, best: s.best, last: s.last, answered: s.answered,
          // `finished` = state of the LATEST attempt, so a student who hit "Try again"
          // shows as in-progress again. `completed` = has finished at least once.
          finished: !!s.last_finished, completed: s.dones > 0,
          seen: s.seen || s.first_seen
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
      const lines = [["Name", "Best", "Last", "Attempts", "Answered", "Total", "Finished", "First seen", "Last seen", "Hidden"].map(cell).join(",")];
      for (const s of q.roster.all(session.id)) {
        lines.push([s.name, s.best, s.last, s.attempts, s.answered, TOTAL,
                    s.dones > 0 ? "yes" : "no", iso(s.first_seen), iso(s.seen), s.hidden ? "yes" : "no"]
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
  console.log(`quiz server on :${PORT}  db=${DB_PATH}  questions=${TOTAL}  admin=${ADMIN_PW ? "set" : "NOT SET"}`);
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
