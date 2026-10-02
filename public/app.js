// The student's phone: an answer pad, nothing more. The question is read off the board;
// this page shows the four options, the clock, and what the last answer cost.
//
// Deliberately NOT imported here: questions.js. The server sends the four option texts of
// the live question only, so the page source a student can read contains no question bank
// and no answer key at all.
//
// There is also no offline queue any more. Under a hard 15-second server-side deadline a
// retry queue would faithfully deliver answers that are already too late to score, which
// is worse than useless -- it would promise points that never arrive. So an answer is
// posted immediately and retried only inside its own window.

const $ = s => document.querySelector(s);
const TKEY = "bq.token", NKEY = "bq.name";
const LETTERS = ["A", "B", "C", "D"];        // the board labels the options the same way
const SCREENS = ["join", "wait", "play", "fin"];
const bust = p => p + (p.includes("?") ? "&" : "?") + "t=" + Date.now();   // beat proxy caches

let token = localStorage.getItem(TKEY) || "";
let state = null;
let clockAnchor = null;      // { at: performance.now(), ms } -- the phone's clock is never used
let paintedIndex = -1;
let sending = false;
let timer = null;

const show = id => SCREENS.forEach(s => $("#" + s).classList.toggle("hidden", s !== id));
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4)] || "th");
const num = n => Number(n || 0).toLocaleString("en-US");

function status(state_, text) {
  const el = $("#sync");
  if (!state_) { el.classList.add("hidden"); return }
  el.classList.remove("hidden");
  el.dataset.state = state_;
  el.textContent = text;
}

async function post(path, body) {
  const r = await fetch(bust(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body)
  });
  if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e }
  return r.json();
}

/* ------------------------------------------------------------------ join --- */
$("#name").value = localStorage.getItem(NKEY) || "";

$("#joinForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#name").value.replace(/\s+/g, " ").trim();
  if (name.length < 2) { $("#joinErr").textContent = "Please type your full name."; return }

  const btn = $("#joinBtn");
  btn.disabled = true; btn.textContent = "Joining…"; $("#joinErr").textContent = "";
  try {
    const r = await post("/api/join", { name });
    // Joining with a name that is already in this session hands back the SAME attempt, so
    // a reload or a locked phone never costs a student their answers -- and never buys
    // them a second go either.
    token = r.token;
    localStorage.setItem(TKEY, token);
    localStorage.setItem(NKEY, r.name || name);
    $("#who").textContent = `Signed in as ${r.name || name}.`;
    startPolling();
  } catch (err) {
    $("#joinErr").textContent = err.status === 409
      ? "The exam is not open for new students. Ask your lecturer."
      : err.status === 429
      ? "This session is full."
      : "Couldn't reach the server. Check the Wi-Fi and try again.";
  } finally {
    btn.disabled = false; btn.textContent = "Join the exam";
  }
});

/* ---------------------------------------------------------------- answer --- */
async function answer(k) {
  if (sending || !state || state.phase !== "question" || state.answered) return;
  sending = true;
  state.answered = true; state.myChoice = k;   // lock the buttons on this tap, not on the reply
  renderPlay();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await post("/api/answer", { token, qIndex: state.qIndex, choice: k });
      state.myChoice = r.choice;               // the first answer stands; believe the server
      status(null);
      sending = false;
      return;
    } catch (err) {
      if (err.status === 409) {                // the window closed while this was in flight
        status("wait", "That question had already closed.");
        sending = false;
        return;
      }
      if (attempt === 2) {
        status("wait", "That answer didn't send. Check the Wi-Fi.");
        state.answered = false;                // let them try again inside what is left
        sending = false;
        renderPlay();
        return;
      }
      await new Promise(done => setTimeout(done, 400));
    }
  }
}

/* ------------------------------------------------------------------ poll --- */
async function poll() {
  if (!token) return;
  try {
    const r = await fetch(bust("/api/state?token=" + encodeURIComponent(token)), { cache: "no-store" });
    if (r.status === 404) {                    // the session was replaced: start clean
      localStorage.removeItem(TKEY);
      token = "";
      show("join");
      $("#joinErr").textContent = "That exam has been reset. Join again.";
      return;
    }
    if (!r.ok) return;
    // A tap being sent right now owns `answered`; a poll landing mid-flight must not
    // overwrite it with the server's not-yet-updated view.
    const fresh = await r.json();
    if (sending && state) { fresh.answered = state.answered; fresh.myChoice = state.myChoice }
    state = fresh;
    render();
  } catch {
    status("wait", "Reconnecting…");
  }
}

function startPolling() {
  clearTimeout(timer);
  (async function loop() {
    await poll();
    const live = state && (state.phase === "question" || state.phase === "reveal");
    timer = setTimeout(loop, live ? 1000 : 2000);
  })();
}

addEventListener("visibilitychange", () => { if (!document.hidden && token) startPolling() });
addEventListener("online", () => { if (token) startPolling() });

/* ---------------------------------------------------------------- render --- */
function render() {
  if (!state) return;
  if (state.phase === "lobby") {
    show("wait");
    $("#waitTitle").textContent = "You're in";
    $("#waitText").textContent = "Look up at the board. The exam starts when your lecturer says so.";
    if (!$("#who").textContent) $("#who").textContent = `Signed in as ${localStorage.getItem(NKEY) || "you"}.`;
  } else if (state.phase === "question" || state.phase === "reveal") {
    show("play");
    renderPlay();
  } else if (state.phase === "done") {
    show("fin");
    renderDone();
  }
}

function renderPlay() {
  const s = state;
  const revealing = s.phase === "reveal";

  if (s.qIndex !== paintedIndex) {
    const box = $("#popts");
    box.innerHTML = "";
    (s.options || []).forEach((text, k) => {
      const b = document.createElement("button");
      b.className = "opt pad o" + k;
      b.type = "button";
      b.innerHTML = "<b></b><span></span>";
      b.firstChild.textContent = LETTERS[k];
      b.lastChild.textContent = text;
      b.onclick = () => answer(k);
      box.appendChild(b);
    });
    paintedIndex = s.qIndex;
  }

  $("#pno").textContent = `Question ${s.questionNo} / ${s.total}`;
  document.querySelectorAll("#popts .opt").forEach((b, k) => {
    b.disabled = revealing || !!s.answered;
    b.classList.toggle("mine", s.myChoice === k);
    b.classList.toggle("ok",   revealing && k === s.correctIndex);
    b.classList.toggle("bad",  revealing && s.myChoice === k && k !== s.correctIndex);
    b.classList.toggle("dim",  revealing && k !== s.correctIndex && s.myChoice !== k);
  });

  const fb = $("#pfb");
  if (revealing) {
    fb.className = "fb " + (s.wasCorrect ? "ok" : "bad");
    fb.innerHTML = "<b></b><span></span>";
    fb.firstChild.textContent = s.wasCorrect
      ? `Spike! +${num(s.earned)} points`
      : s.answered ? "Subthreshold. No points." : "No answer, no points.";
    fb.lastChild.textContent = `${num(s.myPoints)} points · ${s.myCorrect} correct`
      + (s.myRank ? ` · ${ordinal(s.myRank)} of ${s.ranked}` : "");
  } else if (s.answered) {
    fb.className = "fb";
    fb.innerHTML = "<b></b><span></span>";
    fb.firstChild.textContent = "Locked in.";
    fb.lastChild.textContent = "Look at the board for the answer.";
  } else {
    fb.className = "fb hidden";
  }

  clockAnchor = s.phase === "question" ? { at: performance.now(), ms: s.remainingMs } : null;
}

function renderDone() {
  const s = state;
  $("#fpts").textContent = num(s.myPoints);
  $("#ftitle").textContent =
      s.myRank === 1 ? "You topped the class."
    : s.myRank <= 3  ? `${ordinal(s.myRank)} place. You're on the board.`
    : s.myCorrect === s.total ? "Every question right."
    : s.myCorrect >= s.total * .75 ? "Suprathreshold. Nicely done."
    : s.myCorrect >= s.total / 2 ? "Hovering near threshold."
    : "Subthreshold this time.";
  $("#fsub").textContent = `${s.myCorrect} of ${s.total} correct`
    + (s.myRank ? ` · ${ordinal(s.myRank)} of ${s.ranked} students` : "");
}

// Same trick as the board: the server sends a remaining duration, never a timestamp, so a
// phone with a wrong clock still counts down correctly, and every poll re-anchors it.
setInterval(() => {
  if (!clockAnchor) {
    if (state && state.phase === "reveal") { $("#psecs").textContent = "0"; $("#pclock").style.width = "0%" }
    return;
  }
  const span = Math.max(1, state?.questionMs || 25000);
  const left = Math.max(0, clockAnchor.ms - (performance.now() - clockAnchor.at));
  $("#psecs").textContent = Math.ceil(left / 1000);
  $("#psecs").classList.toggle("urgent", left <= 5000);
  $("#pclock").style.width = (left / span * 100) + "%";
}, 100);

// Reloaded, or came back to a tab from earlier in the lecture? The token is enough to
// drop straight back into whatever the class is doing now.
if (token) { show("wait"); startPolling() }
