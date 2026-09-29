// Lecturer's live panel. Polls every 3s -- no WebSockets, because school proxies
// break them. The password lives in sessionStorage only, so closing the tab logs out.

import { QUESTIONS } from "./questions.js";

const $ = s => document.querySelector(s);
const PKEY = "bq.admin";
const QTEXT = new Map(QUESTIONS.map(q => [q.id, q.q]));

let pw = sessionStorage.getItem(PKEY) || "";
let sessionId = null;          // null = whichever session is currently open
let sort = { key: "best", dir: -1 };
let data = null;
let poller = null;

/* ------------------------------------------------------------------ fetch --- */
async function call(path, opts = {}) {
  const r = await fetch(path + (path.includes("?") ? "&" : "?") + "t=" + Date.now(), {
    ...opts,
    cache: "no-store",
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + pw }
  });
  if (r.status === 401) throw new Error("401");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r;
}
const getJSON = p => call(p).then(r => r.json());
const postJSON = (p, body) => call(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
}).then(r => r.json());

/* ------------------------------------------------------------------ login --- */
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  pw = $("#pw").value;
  try {
    await getJSON("/api/admin/live");
    sessionStorage.setItem(PKEY, pw);
    open();
  } catch (err) {
    $("#loginErr").textContent = err.message === "401"
      ? "Wrong password."
      : "Couldn't reach the server.";
  }
});

function logout(msg) {
  clearInterval(poller);
  sessionStorage.removeItem(PKEY);
  pw = "";
  $("#panel").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#loginErr").textContent = msg || "";
}

function open() {
  $("#login").classList.add("hidden");
  $("#panel").classList.remove("hidden");
  tick();
  clearInterval(poller);
  poller = setInterval(() => { if (!document.hidden) tick() }, 3000);
}

/* ------------------------------------------------------------------- poll --- */
async function tick() {
  try {
    data = await getJSON("/api/admin/live" + (sessionId ? "?session=" + sessionId : ""));
    paint();
    $("#tick").textContent = "updated " + new Date().toLocaleTimeString();
  } catch (err) {
    if (err.message === "401") return logout("Session expired. Sign in again.");
    $("#tick").textContent = "connection lost — retrying";
  }
}

/* ------------------------------------------------------------------ paint --- */
const esc = s => { const d = document.createElement("div"); d.textContent = s; return d.innerHTML };
const ago = ts => {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
};

function paint() {
  const { session, sessions, students, questions, total } = data;

  // session controls
  const sel = $("#session");
  if (sel.dataset.n !== String(sessions.length) || sel.value !== String(session.id)) {
    sel.innerHTML = sessions.map(s =>
      `<option value="${s.id}">${esc(s.label)}${s.is_open ? " · open" : ""} (${s.students})</option>`
    ).join("");
    sel.value = String(session.id);
    sel.dataset.n = String(sessions.length);
  }
  $("#toggleOpen").textContent = session.is_open ? "Close session" : "Reopen session";

  // cards
  const visible = students.filter(s => !s.hidden);
  const finished = visible.filter(s => s.completed).length;   // finished at least once
  const avg = visible.length
    ? (visible.reduce((a, s) => a + s.best, 0) / visible.length).toFixed(1) : null;
  $("#cJoined").textContent = visible.length;
  $("#cFinished").textContent = finished;
  $("#cAvg").textContent = avg ? `${avg}/${total}` : "–";
  const asked = questions.reduce((a, q) => a + q.asked, 0);
  const right = questions.reduce((a, q) => a + q.correct, 0);
  $("#cAcc").textContent = asked ? Math.round(right / asked * 100) + "%" : "–";

  // table
  const term = $("#search").value.toLowerCase().trim();
  const rows = students
    .filter(s => !term || s.name.toLowerCase().includes(term))
    .sort((a, b) => {
      const k = sort.key;
      const va = k === "name" ? a.name.toLowerCase() : a[k] ?? 0;
      const vb = k === "name" ? b.name.toLowerCase() : b[k] ?? 0;
      if (va < vb) return -sort.dir;
      if (va > vb) return sort.dir;
      return a.name.localeCompare(b.name);
    });

  $("#rows").innerHTML = rows.map((s, n) => `
    <tr class="${s.hidden ? "dimmed" : ""}">
      <td class="rank">${n + 1}</td>
      <td class="name">${esc(s.name)}</td>
      <td class="num"><b>${s.best}</b>/${total}</td>
      <td class="num">${s.last}/${total}</td>
      <td class="num">${s.attempts}</td>
      <td class="num">${s.answered}/${total}</td>
      <td>${ago(s.seen)}</td>
      <td>${s.finished
            ? '<span class="pill">done</span>'
            : '<span class="pill run">in progress</span>'}</td>
      <td><button class="rowbtn" data-hide="${s.id}">${s.hidden ? "show" : "hide"}</button></td>
    </tr>`).join("");

  $("#empty").textContent = students.length
    ? (rows.length ? "" : "No name matches that filter.")
    : "Nobody has joined yet. Project present.html and let the class scan the QR code.";

  // Per-question difficulty, hardest first. Questions nobody has reached yet sink to
  // the bottom -- 0 of 0 is "no data", not "the whole class missed it".
  const qs = questions.slice().sort((a, b) =>
    (b.asked > 0) - (a.asked > 0) || a.pct - b.pct);
  $("#qrows").innerHTML = qs.map(q => `
    <div class="qrow ${q.asked && q.pct < 60 ? "weak" : ""}">
      <div>
        <p>${esc(QTEXT.get(q.id) || q.id)}</p>
        <div class="track"><i style="width:${q.asked ? q.pct : 0}%"></i></div>
      </div>
      <div class="pct">${q.asked ? q.pct + "%" : "—"}<small>${q.correct}/${q.asked}</small></div>
    </div>`).join("");
}

/* --------------------------------------------------------------- controls --- */
$("#search").addEventListener("input", () => data && paint());

document.querySelectorAll("th[data-sort]").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    sort = { key: k, dir: sort.key === k ? -sort.dir : (k === "name" ? 1 : -1) };
    document.querySelectorAll("th[data-sort]").forEach(x => x.removeAttribute("aria-sort"));
    th.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
    if (data) paint();
  });
});

$("#session").addEventListener("change", e => {
  sessionId = e.target.value;
  tick();
});

$("#toggleOpen").addEventListener("click", async () => {
  const opening = !data.session.is_open;
  await postJSON("/api/admin/session", { action: opening ? "open" : "close", id: data.session.id });
  tick();
});

$("#newSession").addEventListener("click", async () => {
  const label = prompt("Label for the new session:",
    new Date().toLocaleDateString() + " · Bioelectricity");
  if (!label) return;
  const r = await postJSON("/api/admin/session", { action: "create", label });
  sessionId = String(r.id);
  tick();
});

$("#rows").addEventListener("click", async e => {
  const id = e.target.dataset?.hide;
  if (!id) return;
  const s = data.students.find(x => String(x.id) === id);
  await postJSON("/api/admin/student", { action: s.hidden ? "show" : "hide", id: Number(id) });
  tick();
});

$("#csv").addEventListener("click", async () => {
  const r = await call("/api/admin/export.csv" + (sessionId ? "?session=" + sessionId : ""));
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `quiz-results-${data.session.label.replace(/[^\w.-]+/g, "_")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// Already signed in this tab? Go straight in.
if (pw) getJSON("/api/admin/live").then(open).catch(() => logout());
