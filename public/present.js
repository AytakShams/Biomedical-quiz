// Projector view: a big QR code plus a live join counter, so the lecturer can tell
// from the podium whether the class is actually getting in.
// Polling, not WebSockets -- school proxies break WebSockets far too often.

(function () {
  var TKEY = "bq.showTop";

  /* ------------------------------------------------------------- QR code --- */
  // ?url=… lets the lecturer point the QR at a copy reachable under another hostname
  // (for example Coolify's generated domain before the custom domain is attached).
  var def = /^https?:$/.test(location.protocol) ? location.origin + "/" : "";

  function draw(url) {
    url = (url || "").trim();
    document.getElementById("url").textContent =
      url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    var box = document.getElementById("qr");
    if (!url) { box.innerHTML = "<p>Paste the quiz link below.</p>"; return }
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  }

  var inp = document.getElementById("link");
  var start = new URLSearchParams(location.search).get("url") || def;
  inp.value = start;
  draw(start);

  document.getElementById("set").onsubmit = function (e) {
    e.preventDefault();
    draw(inp.value);
    history.replaceState(null, "", "?url=" + encodeURIComponent(inp.value.trim()));
  };

  /* --------------------------------------------------------- live counter --- */
  var topOn = localStorage.getItem(TKEY) === "1";
  var topBox = document.getElementById("top");
  var btn = document.getElementById("toggleTop");

  function paintToggle() {
    topBox.classList.toggle("hidden", !topOn);
    btn.textContent = topOn ? "Hide top 10" : "Show top 10";
  }
  btn.onclick = function () {
    topOn = !topOn;
    localStorage.setItem(TKEY, topOn ? "1" : "0");
    paintToggle();
    poll();
  };
  paintToggle();

  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML }

  function poll() {
    fetch("/api/board?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) {
        if (!d) return;
        document.getElementById("joined").innerHTML =
          "<b>" + d.joined + "</b> joined" +
          (d.finished ? " · " + d.finished + " finished" : "");
        if (topOn) {
          document.getElementById("topList").innerHTML = (d.top || []).map(function (s) {
            return "<li><span>" + esc(s.name) + "</span><b>" + s.score + "/" + s.total + "</b></li>";
          }).join("") || "<li><span>Waiting for the first score…</span></li>";
        }
      })
      .catch(function () { /* projector keeps showing the last good numbers */ });
  }

  poll();
  setInterval(poll, 4000);
})();
