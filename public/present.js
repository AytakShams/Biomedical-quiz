// The lecturer's board: the only page that drives the exam, and it does so with exactly
// two buttons -- "Start" and "Next" -- because the server closes each 15-second window by
// itself. If this tab is backgrounded or reloaded the exam carries on regardless; the
// board is a display of the server's state, never the state itself.
//
// Polling, not WebSockets: school proxies break WebSockets far too often.

import { QUESTIONS, optionsFor, LETTERS } from "./questions.js";

const $ = s => document.querySelector(s);
const PKEY = "bq.admin";            // shared with admin.html: sign in once per browser
const SCREENS = ["lobby", "ask", "done"];

let pw = sessionStorage.getItem(PKEY) || "";
let data = null;
let poller = null;
let shownIndex = -1;                // what is painted, so the DOM is not rebuilt every second
let shownPhase = "";
let clockAnchor = null;             // { at: performance.now(), ms } -- see tickClock()
let podiumRevealed = false;

const esc = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML };
const show = id => SCREENS.forEach(s => $("#" + s).classList.toggle("hidden", s !== id));

/* ------------------------------------------------------------------- auth --- */
async function call(path, opts = {}) {
  const r = await fetch(path + (path.includes("?") ? "&" : "?") + "t=" + Date.now(), {
    ...opts,
    cache: "no-store",
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + pw }
  });
  if (r.status === 401) throw new Error("401");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  pw = $("#pw").value;
  try {
    await call("/api/admin/live");              // cheapest authenticated route
    sessionStorage.setItem(PKEY, pw);
    openBoard();
  } catch (err) {
    $("#loginErr").textContent = err.message === "401" ? "Wrong password." : "Couldn't reach the server.";
  }
});

function logout(msg) {
  clearInterval(poller);
  sessionStorage.removeItem(PKEY);
  pw = "";
  SCREENS.forEach(s => $("#" + s).classList.add("hidden"));
  $("#login").classList.remove("hidden");
  $("#loginErr").textContent = msg || "";
}

function openBoard() {
  $("#login").classList.add("hidden");
  drawQR(inp.value);
  poll();
  clearInterval(poller);
  poller = setInterval(poll, 1000);
}

/* ----------------------------------------------------------------- QR code --- */
// ?url=… lets the lecturer point the QR at a copy reachable under another hostname
// (for example Coolify's generated domain before the custom domain is attached).
const inp = $("#link");
const def = /^https?:$/.test(location.protocol) ? location.origin + "/" : "";
inp.value = new URLSearchParams(location.search).get("url") || def;

function drawQR(url) {
  url = (url || "").trim();
  $("#url").textContent = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const box = $("#qr");
  if (!url) { box.innerHTML = "<p>Paste the quiz link below.</p>"; return }
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

$("#set").addEventListener("submit", e => {
  e.preventDefault();
  drawQR(inp.value);
  history.replaceState(null, "", "?url=" + encodeURIComponent(inp.value.trim()));
});

/* ------------------------------------------------------------------- poll --- */
// /api/board is unauthenticated on purpose: it holds nothing secret (the correct answer
// appears only once the class has already seen the reveal), and keeping the display
// independent of the password means a projector never drops to a login form mid-lecture.
async function poll() {
  try {
    const r = await fetch("/api/board?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    data = await r.json();
    paint();
  } catch { /* keep the last good frame on the projector */ }
}

async function control(action) {
  try {
    data = await call("/api/admin/control", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action })
    });
    paint();
  } catch (err) {
    if (err.message === "401") logout("Session expired. Sign in again.");
  }
}

$("#start").addEventListener("click", () => control("start"));
$("#next").addEventListener("click", async () => {
  $("#next").disabled = true;
  await control("next");
  $("#next").disabled = false;
});

/* ------------------------------------------------------------------ paint --- */
function paint() {
  if (!data) return;

  if (data.phase === "lobby") {
    show("lobby");
    $("#joined").textContent = data.joined;
    $("#names").innerHTML = (data.names || []).map(n => `<span>${esc(n)}</span>`).join("");
    $("#start").disabled = !data.joined;
    $("#startNote").textContent = data.joined
      ? "One attempt each. Everyone answers the same question at the same time."
      : "Waiting for the first student to join…";
  } else if (data.phase === "question" || data.phase === "reveal") {
    show("ask");
    paintQuestion();
  } else if (data.phase === "done") {
    show("done");
    paintPodium();
  }
  shownPhase = data.phase;
}

function paintQuestion() {
  const question = QUESTIONS[data.qIndex];
  if (!question) return;
  const { options, correct } = optionsFor(question);
  const revealing = data.phase === "reveal";

  // Rebuild only when the question or the phase actually changes: the counter and the
  // clock update ten times a second and must not fight a full DOM rewrite.
  if (data.qIndex !== shownIndex || data.phase !== shownPhase) {
    $("#qno").textContent = `Question ${data.qIndex + 1} / ${data.total}`;
    $("#qtext").textContent = question.q;
    $("#boardopts").innerHTML = options.map((text, k) => `
      <div class="bopt" data-k="${k}">
        <b>${LETTERS[k]}</b>
        <span>${esc(text)}</span>
        <i class="tally"><u></u><em></em></i>
      </div>`).join("");
    $("#why").textContent = question.why;
    shownIndex = data.qIndex;
  }

  $("#why").classList.toggle("hidden", !revealing);
  $("#next").classList.toggle("hidden", !revealing);
  $("#next").textContent = data.qIndex + 1 < data.total ? "Next question" : "Show the results";
  $("#counter").textContent = `${data.answeredCount} / ${data.joined} answered`;

  const cast = Math.max(1, (data.dist || []).reduce((a, b) => a + b, 0));
  for (const el of document.querySelectorAll(".bopt")) {
    const k = Number(el.dataset.k);
    el.classList.toggle("right", revealing && k === correct);
    el.classList.toggle("miss", revealing && k !== correct);
    if (revealing && data.dist) {
      const n = data.dist[k] || 0;
      el.querySelector("u").style.width = Math.round(n / cast * 100) + "%";
      el.querySelector("em").textContent = n;
    }
  }

  clockAnchor = data.phase === "question" ? { at: performance.now(), ms: data.remainingMs } : null;
}

// The server sends a remaining duration, never a timestamp, so a projector laptop with a
// wrong clock still counts down correctly. Each poll re-anchors it, so the local run can
// never drift away from the server's deadline.
setInterval(() => {
  const span = Math.max(1, data?.questionMs || 15000);
  if (!clockAnchor) {
    $("#clockbar").style.width = shownPhase === "reveal" ? "0%" : "100%";
    if (shownPhase === "reveal") $("#secs").textContent = "0";
    return;
  }
  const left = Math.max(0, clockAnchor.ms - (performance.now() - clockAnchor.at));
  $("#secs").textContent = Math.ceil(left / 1000);
  $("#secs").classList.toggle("urgent", left <= 5000);
  $("#clockbar").style.width = (left / span * 100) + "%";
}, 100);

/* ----------------------------------------------------------------- podium --- */
// Third, then second, then first, a beat apart: the room gets to react to each name
// before the next one lands. Each card is inserted straight into its final left-to-right
// position, so the finished podium reads 1-2-3 even though it was revealed 3-2-1.
function paintPodium() {
  if (podiumRevealed) return;
  podiumRevealed = true;

  const places = data.podium || [];
  $("#podium").innerHTML = "";
  if (!places.length) {
    $("#doneTitle").textContent = "No scores to show";
    $("#doneNote").textContent = "Nobody answered a question in this session.";
    return;
  }

  const MEDAL = ["1st", "2nd", "3rd"];
  const order = [2, 1, 0].filter(k => places[k]);
  order.forEach((k, step) => setTimeout(() => {
    const p = places[k];
    const card = document.createElement("div");
    card.className = `place p${k + 1}`;
    card.innerHTML = `<span class="medal">${MEDAL[k]}</span>
                      <b>${esc(p.name)}</b>
                      <span class="pts">${p.points.toLocaleString("en-US")} pts</span>
                      <span class="note">${p.correct} / ${data.total} correct</span>`;
    const box = $("#podium");
    box.appendChild(card);
    for (const n of [...box.children].sort((a, b) => a.className.localeCompare(b.className)))
      box.appendChild(n);
  }, step * 1200));

  setTimeout(() => {
    $("#leaders").innerHTML = (data.leaders || []).map((r, k) => `
      <li><span class="rank">${k + 1}</span>
          <span class="who">${esc(r.name)}</span>
          <b>${r.points.toLocaleString("en-US")}</b>
          <span class="note">${r.correct}/${data.total}</span></li>`).join("");
    $("#doneNote").textContent =
      `${data.joined} students, one attempt each. Full results and CSV export are on the panel.`;
  }, order.length * 1200);
}

// Already signed in this browser? Go straight to the board.
if (pw) call("/api/admin/live").then(openBoard).catch(() => logout());
