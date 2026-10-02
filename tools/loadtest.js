// Drives a whole synchronized exam against a running server, as a full lecture hall would,
// then checks the lecturer's panel against what each virtual student actually answered.
// This is the test that de-risks exam day.
//
//   node tools/loadtest.js <baseUrl> <adminPassword> [students]
//
// It needs the admin password, because it has to press Start and Next itself.
//
// The exam is paced by the server's 15-second windows, so a full run takes ~3 minutes.
// Start the server with QUESTION_MS=1200 to run the same test in half a minute:
//   ADMIN_PASSWORD=test QUESTION_MS=1200 DB_PATH=./data/test.db node server.js

import { QUESTIONS, optionsFor } from "../public/questions.js";

const [, , base = "http://127.0.0.1:3000", pw = "", countArg = "80"] = process.argv;
const COUNT = Number(countArg);
const TOTAL = QUESTIONS.length;
const ADMIN = { Authorization: "Bearer " + pw };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); return ok };

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, json };
}
const get  = (p, headers) => call(p, { headers });
const post = (p, body, headers) => call(p, { method: "POST", body, headers });

/* ------------------------------------------------------------------ setup --- */
const probe = await get("/api/admin/live", ADMIN);
if (probe.status === 401) {
  console.error("\nThe admin password is wrong, and this test cannot run the exam without it.");
  console.error("  node tools/loadtest.js <baseUrl> <adminPassword> [students]\n");
  process.exit(1);
}

// A fresh session, so the test never lands in the middle of a half-played lecture.
await post("/api/admin/session", { action: "create", label: "Load test" }, ADMIN);

const window_ = (await get("/api/board")).json.questionMs || 25000;
console.log(`\n${COUNT} students · ${TOTAL} questions · ${window_ / 1000}s per question`);
console.log(`expect this to take about ${Math.ceil(TOTAL * (window_ + 900) / 1000)}s\n`);

const t0 = Date.now();

/* ------------------------------------------------------------------- join --- */
const students = await Promise.all(Array.from({ length: COUNT }, async (_, i) => {
  const n = i + 1;
  const name = `Test Student ${String(n).padStart(3, "0")}`;
  const r = await post("/api/join", { name });
  return {
    n, name, token: r.json?.token,
    skill: 0.35 + (n % 7) / 10,     // a per-student hit rate, so scores spread out
    points: 0, correct: 0, sent: 0
  };
}));
check(students.every(s => s.token), "some students failed to join");

// The single-attempt rule: joining again under the same name must hand back the SAME
// attempt, not open a second one.
const rejoin = await post("/api/join", { name: students[0].name });
check(rejoin.json?.token === students[0].token, "re-joining issued a NEW token (single-attempt rule broken)");

// Student 001 never answers anything: an abstainer has to end on zero, not on a default.
const ABSTAINER = 1;

async function waitFor(phase, qIndex) {
  for (let i = 0; i < 400; i++) {
    const b = (await get("/api/board")).json;
    if (b.phase === phase && (qIndex === undefined || b.qIndex === qIndex)) return b;
    await sleep(100);
  }
  problems.push(`server never reached phase "${phase}" for question ${qIndex}`);
  return null;
}

/* ------------------------------------------------------------------- exam --- */
await post("/api/admin/control", { action: "start" }, ADMIN);

let replayDrift = 0, lateAccepted = 0, badPoints = 0;

for (let qi = 0; qi < TOTAL; qi++) {
  const live = (await get("/api/board")).json;
  check(live.phase === "question" && live.qIndex === qi, `question ${qi}: board is ${live.phase}/${live.qIndex}`);

  const { correct } = optionsFor(QUESTIONS[qi]);

  await Promise.all(students.filter(s => s.n !== ABSTAINER).map(async s => {
    await sleep((s.n % 6) * 30);                       // stagger, so the points differ
    const right = Math.random() < s.skill;
    const choice = right ? correct : (correct + 1 + (s.n % 3)) % 4;
    const r = await post("/api/answer", { token: s.token, qIndex: qi, choice });
    if (!r.ok) return;

    s.sent++;
    s.points += r.json.points;
    s.correct += r.json.correct ? 1 : 0;
    // Points must match the published formula, and a wrong answer must be worth nothing.
    if (r.json.correct ? (r.json.points < 1000 || r.json.points > 1200) : r.json.points !== 0) badPoints++;

    // A second tap -- on a DIFFERENT option -- must change nothing at all.
    const replay = await post("/api/answer", { token: s.token, qIndex: qi, choice: (choice + 1) % 4 });
    if (replay.json?.points !== r.json.points || replay.json?.choice !== r.json.choice) replayDrift++;
  }));

  // Nobody closes the window: the server has to do it by itself on the next read. That is
  // what keeps the exam alive when the board tab is backgrounded or closed.
  const revealed = await waitFor("reveal", qi);
  if (revealed) {
    const cast = (revealed.dist || []).reduce((a, b) => a + b, 0);
    check(cast === revealed.answeredCount, `question ${qi}: vote tally ${cast} != answered ${revealed.answeredCount}`);
    check(revealed.correctIndex === correct, `question ${qi}: board revealed the wrong option`);
  }

  // The window has closed, so this must be refused rather than scored.
  const late = await post("/api/answer", { token: students[1].token, qIndex: qi, choice: correct });
  if (late.status !== 409) lateAccepted++;

  await post("/api/admin/control", { action: "next" }, ADMIN);
}

const final = await waitFor("done");
const ms = Date.now() - t0;

/* ----------------------------------------------------------------- verify --- */
const live = (await get("/api/admin/live", ADMIN)).json;
const rows = new Map(live.students.map(s => [s.name, s]));
const mine = students.filter(s => s.n !== ABSTAINER);

const wrongPoints  = mine.filter(s => rows.get(s.name)?.points !== s.points);
const wrongCorrect = mine.filter(s => rows.get(s.name)?.correct !== s.correct);
const notAnswered  = mine.filter(s => rows.get(s.name)?.answered !== TOTAL);
const notFinished  = students.filter(s => !rows.get(s.name)?.finished);
const abstainer    = rows.get(students[ABSTAINER - 1].name);

// Independently rank what the test itself recorded, and demand the same three scores on
// the podium. Compared by points, not by name, so a genuine tie cannot flake the test.
const ranked = [...mine].sort((a, b) => b.points - a.points);
const expectTop = ranked.slice(0, 3).map(s => s.points);
const gotTop = (final?.podium || []).map(p => p.points);

check(!wrongPoints.length,  `${wrongPoints.length} students' points disagree with the panel`);
check(!wrongCorrect.length, `${wrongCorrect.length} students' correct counts disagree with the panel`);
check(!notAnswered.length,  `${notAnswered.length} students are not on ${TOTAL}/${TOTAL} answered`);
check(!notFinished.length,  `${notFinished.length} students were never marked finished`);
check(!replayDrift,         `${replayDrift} replayed answers changed a stored score`);
check(!lateAccepted,        `${lateAccepted} answers were accepted after the window closed`);
check(!badPoints,           `${badPoints} answers were scored outside the published formula`);
check(abstainer?.points === 0 && abstainer?.answered === 0, "the abstaining student did not end on zero");
check(JSON.stringify(gotTop) === JSON.stringify(expectTop),
      `podium ${JSON.stringify(gotTop)} does not match the expected top three ${JSON.stringify(expectTop)}`);

/* ------------------------------------------------------------------ print --- */
const requests = COUNT + 1 + mine.length * TOTAL * 2 + TOTAL * 2;
console.log(`finished in ${(ms / 1000).toFixed(1)}s  (~${requests} requests)`);
console.log(`panel rows        : ${live.students.length} (expected ${COUNT})`);
console.log(`answered ${TOTAL}/${TOTAL}    : ${mine.filter(s => rows.get(s.name)?.answered === TOTAL).length}/${mine.length}`);
console.log(`abstainer         : ${abstainer?.points} points, ${abstainer?.answered} answered  <- must be 0, 0`);
console.log(`replay drift      : ${replayDrift}  <- a second tap must never rescore`);
console.log(`late accepted     : ${lateAccepted}  <- the 15s window must be server-enforced`);
console.log(`class accuracy    : ${(() => {
  const a = live.questions.reduce((x, q) => x + q.asked, 0);
  const c = live.questions.reduce((x, q) => x + q.correct, 0);
  return a ? Math.round(c / a * 100) + "%" : "n/a";
})()}`);
console.log(`podium            : ${(final?.podium || []).map(p => `${p.name} ${p.points}`).join(" | ") || "(empty)"}`);

if (problems.length) {
  console.log("\nFAIL");
  for (const p of problems) console.log("  - " + p);
  console.log();
  process.exit(1);
}
console.log("\nPASS\n");
