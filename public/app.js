// Student quiz. Practice mode: instant feedback, unlimited retries.
//
// Network model, built for flaky lecture-hall Wi-Fi:
//   * questions + answer key ship with the page, so once loaded the quiz runs OFFLINE;
//   * every answer goes into a localStorage queue and is flushed in batches;
//   * a failed flush retries with exponential backoff -- nothing is ever lost;
//   * the server re-grades from the submitted choice text, so the score it stores is
//     authoritative. The key being here lets a student peek, not forge a score.

import { QUIZ, QUESTIONS, ANSWER_KEY } from "./questions.js";

const $ = s => document.querySelector(s);
const N = QUESTIONS.length;

/* ---------------------------------------------------------------- queue --- */
const QKEY = "bq.queue", NKEY = "bq.name";
const api = p => p + (p.includes("?") ? "&" : "?") + "t=" + Date.now(); // beat proxy caches

let queue = load();
let flushing = false, fails = 0, timer = null;

function load(){ try { return JSON.parse(localStorage.getItem(QKEY)) || [] } catch { return [] } }
function save(){ try { localStorage.setItem(QKEY, JSON.stringify(queue)) } catch {} }

function enqueue(item){ queue.push(item); save(); schedule(120) }

function schedule(ms){
  clearTimeout(timer);
  timer = setTimeout(flush, ms);
}

async function post(path, body){
  const r = await fetch(api(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e }
  return r.json();
}

// A 4xx means the server has rejected this attempt for good (unknown token, bad body).
// Retrying can never succeed, so those items are dropped rather than queued forever --
// otherwise the pill would keep promising a delivery that will never happen.
const permanent = err => err.status >= 400 && err.status < 500
                      && err.status !== 408 && err.status !== 429;

// Sends everything pending, attempt by attempt: answers first, then that attempt's
// finish. One failing attempt never blocks the others.
async function flush(){
  if (flushing || !queue.length) return;
  flushing = true;
  status("wait", "Saving…");
  let stalled = false, dropped = false;

  try {
    for (const token of [...new Set(queue.map(i => i.token))]) {
      try {
        const answers = queue.filter(i => i.token === token && !i.fin);
        if (answers.length) {
          // The score this returns is a RUNNING total over whatever has arrived so
          // far, so it is deliberately ignored -- only /api/finish is authoritative.
          await post("/api/answers", {
            token,
            answers: answers.map(({ qId, choice, ms, at }) => ({ qId, choice, ms, at }))
          });
          queue = queue.filter(i => !(i.token === token && !i.fin));
          save();
        }
        const fin = queue.find(i => i.token === token && i.fin);
        if (fin) {
          const res = await post("/api/finish", { token });
          if (typeof res.score === "number") { serverScore = res.score; paintScore() }
          queue = queue.filter(i => i !== fin);
          save();
        }
      } catch (err) {
        if (permanent(err)) { queue = queue.filter(i => i.token !== token); save(); dropped = true }
        else stalled = true;
      }
    }
  } finally {
    flushing = false;
  }

  if (stalled) {
    fails++;
    status("wait", "No connection — your answers are safe on this phone and will be sent automatically.");
    schedule(Math.min(30000, 1000 * 2 ** fails) + Math.random() * 500);
  } else if (dropped) {
    // The server refused this attempt outright, so those answers are gone. Say so
    // plainly rather than showing "Saved" over data that was discarded.
    fails = 0;
    status("wait", "This attempt could not be saved. Please reload the page and start again.");
  } else {
    fails = 0;
    status("ok", "Saved");
    setTimeout(() => { if (!queue.length) status(null) }, 1600);
  }
}

function status(state, text){
  const el = $("#sync");
  if (!state) { el.classList.add("hidden"); return }
  el.classList.remove("hidden");
  el.dataset.state = state;
  el.textContent = text;
}

addEventListener("online", () => { fails = 0; schedule(200) });
addEventListener("visibilitychange", () => { if (!document.hidden) schedule(200) });
// Last-ditch delivery if the student closes the tab mid-quiz.
addEventListener("pagehide", () => {
  if (!queue.length || !navigator.sendBeacon) return;
  const token = queue[0].token;
  const answers = queue.filter(i => i.token === token && !i.fin)
                       .map(({ qId, choice, ms, at }) => ({ qId, choice, ms, at }));
  if (!answers.length) return;
  navigator.sendBeacon("/api/answers",
    new Blob([JSON.stringify({ token, answers })], { type: "application/json" }));
});

/* ----------------------------------------------------------------- state --- */
let token = null, order = [], i = 0, score = 0, streak = 0, res = [], shown = 0;
let serverScore = null, student = "";

const show = id => ["join", "quiz", "end", "closed"].forEach(s =>
  $("#" + s).classList.toggle("hidden", s !== id));

const shuffle = a => {
  a = a.slice();
  for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [a[k], a[j]] = [a[j], a[k]] }
  return a;
};

/* ------------------------------------------------------------------ join --- */
$("#blurb").textContent = QUIZ.blurb + " About 5 minutes.";
$("#name").value = localStorage.getItem(NKEY) || "";

$("#joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#name").value.replace(/\s+/g, " ").trim();
  if (name.length < 2) { $("#joinErr").textContent = "Please type your full name."; return }

  const btn = $("#joinBtn");
  btn.disabled = true; btn.textContent = "Joining…"; $("#joinErr").textContent = "";
  try {
    const r = await post("/api/join", { name, quizId: QUIZ.id, total: N });
    token = r.token; student = r.name || name;
    localStorage.setItem(NKEY, student);
    start();
  } catch (err) {
    $("#joinErr").textContent = String(err.message).includes("409")
      ? "The quiz isn't open yet. Ask your lecturer to start it."
      : "Couldn't reach the server. Check the Wi-Fi and try again.";
  } finally {
    btn.disabled = false; btn.textContent = "Start the quiz";
  }
});

$("#retry").addEventListener("click", () => location.reload());

/* ------------------------------------------------------------------ quiz --- */
function start(){
  order = shuffle(QUESTIONS.map((_, k) => k));
  i = 0; score = 0; streak = 0; res = []; serverScore = null;
  show("quiz"); render();
}

// Builds the action-potential trace: a spike per correct answer, a dip per miss.
function pts(){
  const w = 360 / N, p = ["0,40"];
  res.forEach((r, k) => {
    const x = k * w;
    p.push(r ? `${x + w * .2},40 ${x + w * .3},4 ${x + w * .45},44 ${x + w * .6},48 ${x + w * .8},40`
             : `${x + w * .3},46 ${x + w * .6},50 ${x + w * .85},40`);
  });
  p.push(360 * res.length / N + ",40");
  return p.join(" ");
}

function render(){
  const item = QUESTIONS[order[i]];
  $("#q").textContent = item.q;
  $("#cnt").textContent = `Question ${i + 1} of ${N}`;
  $("#stk").textContent = streak > 1 ? `Streak ×${streak}` : "";
  $("#tr").setAttribute("points", pts());

  const box = $("#opts");
  box.innerHTML = "";
  shuffle([[item.correct, 1], ...item.wrong.map(t => [t, 0])]).forEach(([text, ok]) => {
    const b = document.createElement("button");
    // dataset stringifies whatever it is given; say "1"/"0" outright so the read
    // side below compares against exactly what was written.
    b.className = "opt"; b.type = "button"; b.textContent = text; b.dataset.ok = ok ? "1" : "0";
    b.onclick = () => pick(b, !!ok, text);
    box.appendChild(b);
  });

  $("#fb").classList.add("hidden");
  $("#next").classList.add("hidden");
  $("#q").focus({ preventScroll: true });
  shown = Date.now();
}

function pick(btn, ok, choice){
  const item = QUESTIONS[order[i]];

  document.querySelectorAll(".opt").forEach(x => {
    x.disabled = true;
    if (x.dataset.ok === "1") x.classList.add("ok");
    else if (x !== btn) x.classList.add("dim");
  });
  if (!ok) btn.classList.add("bad");

  res.push(ok);
  ok ? (score++, streak++) : streak = 0;
  $("#tr").setAttribute("points", pts());
  $("#stk").textContent = streak > 1 ? `Streak ×${streak}` : "";

  const f = $("#fb");
  f.className = "fb " + (ok ? "ok" : "bad");
  f.innerHTML = `<b></b><span></span>`;
  f.firstChild.textContent = ok ? "Spike! Threshold reached." : "Subthreshold. Not this time.";
  f.lastChild.textContent = item.why;

  enqueue({ token, qId: item.id, choice, ms: Date.now() - shown, at: Date.now() });

  const n = $("#next");
  n.textContent = i === N - 1 ? "See my result" : "Next question";
  n.classList.remove("hidden");
  n.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

$("#next").addEventListener("click", () => { i++; i < N ? render() : done() });
$("#again").addEventListener("click", async () => {
  // A retry is a brand-new attempt: ask the server for a fresh token so both
  // attempts are kept and the lecturer sees the try count.
  const btn = $("#again");
  btn.disabled = true; btn.textContent = "Starting…";
  try {
    const r = await post("/api/join", { name: student, quizId: QUIZ.id, total: N });
    token = r.token;
    start();
  } catch {
    status("wait", "Can't start a new attempt while offline. Try again in a moment.");
  } finally {
    btn.disabled = false; btn.textContent = "Try again (options reshuffle)";
  }
});

function done(){
  show("end");
  $("#tr2").setAttribute("points", pts());
  $("#dots").innerHTML = res.map(r => `<i class="${r ? "o" : ""}"></i>`).join("");
  $("#whoami").textContent = `Recorded as ${student}.`;
  paintScore();
  enqueue({ token, fin: true });
}

function paintScore(){
  const s = serverScore ?? score;
  $("#sc").textContent = `${s} / ${N}`;
  $("#ti").textContent =
    s === N ? "Full-size spike. All-or-none, and you went all."
    : s >= 9 ? "Suprathreshold. Nicely done."
    : s >= 6 ? "Hovering near threshold. One more stimulus."
    : "Subthreshold. Review the explanations and try again.";
}

// Defensive: the key must cover every question, or grading would silently skip one.
if (ANSWER_KEY.size !== N) console.warn("questions.js: answer key does not cover every question");

// Flush anything left over from a previous visit (tab closed mid-quiz, Wi-Fi died).
if (queue.length) schedule(400);
