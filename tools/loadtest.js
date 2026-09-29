// Simulates a full lecture hall against a running server, then checks the panel's
// numbers against what each virtual student actually answered. This is the test that
// de-risks exam day: it proves 80 concurrent phones land 80 correct rows.
//
//   node tools/loadtest.js <baseUrl> <adminPassword> [students] [--replay]
//
// --replay re-sends every batch a second time, proving the retry queue cannot
// double-count (answers has PRIMARY KEY (attempt_id, q_id)).

import { QUESTIONS } from "../public/questions.js";

const [, , base = "http://127.0.0.1:3000", pw = "", countArg = "80"] = process.argv;
const COUNT  = Number(countArg);
const REPLAY = process.argv.includes("--replay");
const TOTAL  = QUESTIONS.length;

const post = async (path, body) => {
  const r = await fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
};

// Each student answers with a per-student skill level, so scores spread out realistically.
async function student(n) {
  const name = `Test Student ${String(n).padStart(3, "0")}`;
  const skill = 0.35 + (n % 7) / 10;
  const { token } = await post("/api/join", { name });

  const picks = QUESTIONS.map(q => {
    const right = Math.random() < skill;
    return { qId: q.id, choice: right ? q.correct : q.wrong[n % 3], ms: 1500 + (n * 37) % 6000, at: Date.now(), right };
  });
  const expected = picks.filter(p => p.right).length;

  // Three batches, mimicking the client's 2-second flush cadence.
  for (const chunk of [picks.slice(0, 5), picks.slice(5, 9), picks.slice(9)]) {
    const answers = chunk.map(({ qId, choice, ms, at }) => ({ qId, choice, ms, at }));
    await post("/api/answers", { token, answers });
    if (REPLAY) await post("/api/answers", { token, answers });
  }

  const fin = await post("/api/finish", { token });
  if (REPLAY) await post("/api/finish", { token });
  return { name, expected, got: fin.score };
}

const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: COUNT }, (_, i) => student(i + 1).catch(e => ({ error: e.message })))
);
const ms = Date.now() - t0;

const failed   = results.filter(r => r.error);
const mismatch = results.filter(r => !r.error && r.expected !== r.got);

console.log(`\n${COUNT} students in ${ms} ms  (${(COUNT / (ms / 1000)).toFixed(1)}/s)`);
console.log(`requests: ~${COUNT * (REPLAY ? 9 : 5)}`);
console.log(`errors  : ${failed.length}${failed.length ? "  e.g. " + failed[0].error : ""}`);
console.log(`score mismatches (client expectation vs server): ${mismatch.length}`);
if (mismatch.length) console.log(mismatch.slice(0, 5));

// Cross-check against the lecturer's panel.
const live = await fetch(`${base}/api/admin/live`, { headers: { Authorization: "Bearer " + pw } });
if (!live.ok) {
  console.log(`panel check: SKIPPED (HTTP ${live.status} - pass the admin password as arg 2)`);
} else {
  const d = await live.json();
  const mine = d.students.filter(s => s.name.startsWith("Test Student "));
  const byName = new Map(results.filter(r => !r.error).map(r => [r.name, r.expected]));
  const wrongRow = mine.filter(s => byName.get(s.name) !== s.best);
  const notDone  = mine.filter(s => !s.completed);
  const overTried = mine.filter(s => s.attempts !== 1);

  console.log(`\npanel rows        : ${mine.length} (expected ${COUNT - failed.length})`);
  console.log(`rows w/ bad best  : ${wrongRow.length}`);
  console.log(`rows not finished : ${notDone.length}`);
  console.log(`rows w/ attempts≠1: ${overTried.length}  <- replay must NOT create extra attempts`);
  console.log(`answered 12/12    : ${mine.filter(s => s.answered === TOTAL).length}/${mine.length}`);
  console.log(`class accuracy    : ${(() => {
    const a = d.questions.reduce((x, q) => x + q.asked, 0);
    const c = d.questions.reduce((x, q) => x + q.correct, 0);
    return a ? Math.round(c / a * 100) + "%" : "n/a";
  })()}`);

  const ok = !failed.length && !mismatch.length && !wrongRow.length && !notDone.length
          && !overTried.length && mine.length === COUNT - failed.length;
  console.log(`\n${ok ? "PASS" : "FAIL"}\n`);
  process.exit(ok ? 0 : 1);
}
