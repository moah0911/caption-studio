/* CapCut Studio — local single-user caption editor */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmtTime = (s) => {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
};
const toast = (msg) => {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 2800);
};
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: opts.body && !(opts.body instanceof ArrayBuffer) ? { "Content-Type": "application/json" } : {}, ...opts });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { msg = (await res.text()) || msg; }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
};

const state = {
  projectId: null,
  project: null,
  media: [],
  mediaMeta: null,       // {id, type, duration}
  words: [],             // [{word,start,end}] seconds
  lines: [],             // grouped
  cuts: [],              // [{start,end}] seconds to REMOVE
  applyCuts: true,
  style: { font: "Bebas Neue", size: 96, base: "#ffffff", accent: "#30d158", uppercase: true },
  aspect: "9:16",
  activePanel: "media",
  pxPerSec: 9,
  duration: 0,
  playing: false,
  peaks: null,           // Float32Array minmax
  captionCache: { lineIndex: -1, html: "" },
  rafId: 0,
};

/* ---------- Dashboard ---------- */
const dashboardEl = $("#dashboard");
const editorEl = $("#editor");

async function showDashboard() {
  editorEl.classList.add("hidden");
  dashboardEl.classList.remove("hidden");
  const list = $("#project-list");
  const projects = await api("/api/projects");
  list.innerHTML = "";
  $("#dashboard-empty").classList.toggle("hidden", projects.length !== 0);
  for (const p of projects) {
    const el = document.createElement("div");
    el.className = "project-card";
    el.innerHTML = `<button class="project-del" title="Delete project" aria-label="Delete project">✕</button>
      <button class="project-thumb" style="all:unset;display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;background:#0b0b0c;position:relative;cursor:pointer"></button>
      <div class="project-body"><h3>${escHtml(p.name)}</h3><p>${p.media_count ?? 0} media · ${p.caption_count ?? 0} captions · ${p.aspect ?? "9:16"}</p></div>`;
    const thumb = el.querySelector(".project-thumb");
    thumb.innerHTML = `<span style="font-family:var(--mono);font-size:15px;color:var(--accent)">${escHtml(p.name.slice(0, 2).toUpperCase())}</span><span style="position:absolute;bottom:10px;left:12px;font-family:var(--mono);font-size:11px;color:var(--text-3)">${fmtDate(p.updated_at)}</span>`;
    thumb.addEventListener("click", () => openProject(p.id));
    el.querySelector(".project-del").addEventListener("click", async () => {
      if (!confirm(`Delete “${p.name}” and its media? This cannot be undone.`)) return;
      try {
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        toast("Project deleted");
        showDashboard();
      } catch (err) { toast(`Delete failed: ${err.message}`); }
    });
    list.appendChild(el);
  }
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

async function createProject() {
  const p = await api("/api/projects", { method: "POST", body: JSON.stringify({ name: "Untitled caption" }) });
  openProject(p.id);
}

/* ---------- Project loading ---------- */
async function openProject(id) {
  state.projectId = id;
  const data = await api(`/api/projects/${id}`);
  state.project = data.project;
  state.media = data.media;
  state.mediaMeta = data.media[0] ?? null;
  state.words = (data.transcription?.words ? JSON.parse(data.transcription.words) : []).map((w) => ({
    word: w.word, start: w.start, end: w.end,
  }));
  state.cuts = data.cuts.map((c) => ({ start: c.start_s, end: c.end_s }));
  state.style = { ...state.style, ...(data.project.caption_style ? JSON.parse(data.project.caption_style) : {}) };
  state.aspect = data.project.aspect || "9:16";
  dashboardEl.classList.add("hidden");
  editorEl.classList.remove("hidden");
  $("#doc-name").value = data.project.name;
  $("#ratio-label").textContent = state.aspect;
  $("#stage").dataset.aspect = state.aspect;
  $("#font-select").value = state.style.font;
  $("#font-size").value = state.style.size;
  $("#accent-color").value = state.style.accent;
  $("#base-color").value = state.style.base;
  $("#uppercase-toggle").checked = state.style.uppercase;
  $$('[data-aspect]').forEach((b) => b.classList.toggle("active", b.dataset.aspect === state.aspect));
  renderMediaList();
  renderPresets();
  renderAllCaptions();
  applyStyleToPreview();
  await loadMediaIntoPlayer();
}

const styleSave = debounce(() => {
  if (!state.projectId) return;
  api(`/api/projects/${state.projectId}`, { method: "PUT", body: JSON.stringify({ name: $("#doc-name").value, aspect: state.aspect, caption_style: state.style }) })
    .then(() => setSaveState("Saved"))
    .catch(() => setSaveState("Save failed"));
}, 700);

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function setSaveState(s) { const el = $("#save-state"); el.textContent = s; el.style.color = s === "Saved" ? "var(--text-3)" : "var(--danger)"; }

/* ---------- Media ---------- */
function renderMediaList() {
  const list = $("#media-list");
  list.innerHTML = "";
  for (const m of state.media) {
    const isVideo = (m.type || "").startsWith("video");
    const el = document.createElement("div");
    el.className = "media-item";
    el.innerHTML = `<span class="media-kind">${isVideo ? "MP4" : "MP3"}</span>
      <div class="m-meta"><div class="m-name">${escHtml(m.filename)}</div>
      <div class="m-sub">${m.duration ? fmtTime(m.duration) : "--:--"} · ${(m.size / 1048576).toFixed(1)} MB</div></div>
      <button class="icon-x" title="Remove">✕</button>`;
    el.querySelector(".icon-x").addEventListener("click", async () => {
      await api(`/api/projects/${state.projectId}/media/${m.id}`, { method: "DELETE" });
      state.media = state.media.filter((x) => x.id !== m.id);
      state.mediaMeta = state.media[0] ?? null;
      renderMediaList();
      await loadMediaIntoPlayer();
      toast("Media removed");
    });
    list.appendChild(el);
  }
  $("#stage-empty").classList.toggle("hidden", Boolean(state.mediaMeta));
}

$("#dropzone").addEventListener("click", () => $("#file-input").click());
$("#dropzone").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#file-input").click(); });
$("#file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = "";
  await uploadMedia(file);
});

async function uploadMedia(file) {
  const prog = $("#upload-progress");
  prog.classList.remove("hidden");
  const fill = prog.querySelector(".fill");
  fill.style.width = "0%";
  try {
    const buf = await file.arrayBuffer();
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/projects/${state.projectId}/media?filename=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || "application/octet-stream")}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) fill.style.width = `${Math.round((ev.loaded / ev.total) * 100)}%`; };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.responseText || `${xhr.status}`)));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(buf);
    });
    const data = await api(`/api/projects/${state.projectId}`);
    state.media = data.media;
    state.mediaMeta = state.media.find((m) => m.filename === file.name) ?? state.media[0];
    renderMediaList();
    await loadMediaIntoPlayer();
    toast("Media added — hit Transcribe");
  } catch (err) {
    toast(`Upload failed: ${err.message}`);
  } finally {
    prog.classList.add("hidden");
  }
}

async function loadMediaIntoPlayer() {
  const video = $("#stage-video"), audio = $("#media-audio");
  video.pause(); audio.pause();
  video.removeAttribute("src"); audio.removeAttribute("src");
  video.onloadedmetadata = null; audio.onloadedmetadata = null;
  video.ontimeupdate = null; audio.ontimeupdate = null;
  const meta = state.mediaMeta;
  if (!meta) {
    setDuration(0); drawWaveform(null);
    $("#stage").classList.remove("has-video");
    $("#stage-empty").classList.remove("hidden");
    return;
  }
  const url = `/api/projects/${state.projectId}/media/${meta.id}`;
  const isVideo = (meta.type || "").startsWith("video");
  if (isVideo) {
    video.src = url;
    video.load();
    $("#stage").classList.add("has-video");
    video.onloadedmetadata = () => {
      setDuration(video.duration || meta.duration || 0);
      renderRuler();
    };
    video.ontimeupdate = syncPlayback;
  } else {
    audio.src = url;
    audio.load();
    $("#stage").classList.remove("has-video");
    audio.onloadedmetadata = () => {
      setDuration(audio.duration || meta.duration || 0);
      renderRuler();
    };
    audio.ontimeupdate = syncPlayback;
  }
  $("#stage-empty").classList.add("hidden");
  try {
    const buf = await fetch(url).then((r) => r.arrayBuffer());
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    const decoded = await actx.decodeAudioData(buf);
    state.peaks = computePeaks(decoded);
    state.duration = decoded.duration;
    setDuration(decoded.duration);
    drawWaveform(decoded);
    actx.close();
  } catch (e) {
    console.warn("waveform decode failed:", e);
    drawWaveform(null);
  }
}

function computePeaks(buffer) {
  const ch = buffer.getChannelData(0);
  const buckets = Math.min(4000, ch.length);
  const step = Math.floor(ch.length / buckets);
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * step;
    for (let j = 0; j < step; j += 40) { const v = Math.abs(ch[start + j] || 0); if (v > max) max = v; }
    peaks[i] = max;
  }
  return peaks;
}

function setDuration(s) {
  state.duration = isFinite(s) ? s : 0;
  $("#time-total").textContent = fmtTime(state.duration);
  $("#time-current").textContent = fmtTime(0);
  renderRuler();
}

/* ---------- Timeline drawing ---------- */
function laneWidth() { return Math.max(2400, Math.ceil(state.duration * state.pxPerSec) + 40); }
function drawWaveform(buffer) {
  const canvas = $("#waveform");
  const w = laneWidth();
  canvas.width = w; canvas.height = 140;
  const lane = $("#lane-a1"); lane.style.minWidth = `${w}px`;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, 140);
  if (!buffer && !state.peaks) {
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.beginPath(); ctx.moveTo(0, 70); ctx.lineTo(w, 70); ctx.stroke();
    return;
  }
  const peaks = state.peaks || computePeaksFromBuffer(buffer);
  const n = peaks.length;
  ctx.fillStyle = "#30d158";
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < w; i++) {
    const idx = Math.min(n - 1, Math.floor((i / w) * n));
    const amp = peaks[idx];
    const h = Math.max(2, amp * 120);
    ctx.fillRect(i, (140 - h) / 2, 1, h);
  }
  ctx.globalAlpha = 1;
}
function computePeaksFromBuffer(buffer) { return computePeaks(buffer); }
function drawWaveformPlaceholder() { drawWaveform(null); }
function renderRuler() {
  const ruler = $("#ruler");
  ruler.style.minWidth = `${laneWidth()}px`;
  ruler.innerHTML = "";
  const step = state.duration > 90 ? 15 : 5;
  for (let t = 0; t <= state.duration + 0.01; t += step) {
    const span = document.createElement("span");
    span.textContent = fmtTime(t);
    span.style.left = `${t * state.pxPerSec}px`;
    ruler.appendChild(span);
  }
  $("#lane-v1").style.minWidth = `${laneWidth()}px`;
  $("#lane-t").style.minWidth = `${laneWidth()}px`;
  $("#lane-v1").innerHTML = state.mediaMeta
    ? `<div class="clip-block" style="left:0;width:${Math.max(60, state.duration * state.pxPerSec)}px"><span class="media-kind">${(state.mediaMeta.type || "").startsWith("video") ? "V" : "A"}</span>${escHtml(state.mediaMeta.filename)}</div>`
    : "";
  renderCuts();
  renderCaptionBlocks();
  positionPlayhead(currentMediaTime());
}
function renderCuts() {
  $("#lane-v1").querySelectorAll(".cut-mark").forEach((el) => el.remove());
  for (const cut of state.cuts) {
    const el = document.createElement("div");
    el.className = "cut-mark";
    el.style.left = `${cut.start * state.pxPerSec}px`;
    el.style.width = `${(cut.end - cut.start) * state.pxPerSec}px`;
    el.title = `silence ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s`;
    $("#lane-v1").appendChild(el);
  }
}
function renderCaptionBlocks() {
  const lane = $("#lane-t");
  lane.innerHTML = "";
  lane.style.minWidth = `${laneWidth()}px`;
  for (const [i, line] of state.lines.entries()) {
    const el = document.createElement("button");
    el.className = "caption-seg";
    el.style.left = `${line.start * state.pxPerSec}px`;
    el.style.width = `${Math.max(46, (line.end - line.start) * state.pxPerSec)}px`;
    el.textContent = line.text;
    el.title = `${fmtTime(line.start)} → ${fmtTime(line.end)}`;
    el.addEventListener("click", () => seekTo(line.start + 0.001));
    lane.appendChild(el);
  }
}
function positionPlayhead(t) {
  $("#playhead").style.left = `${40 + t * state.pxPerSec}px`;
}

/* ---------- Playback & captions ---------- */
function currentMediaTime() {
  const el = state.mediaMeta?.type?.startsWith("video") ? $("#stage-video") : $("#media-audio");
  return el ? el.currentTime : 0;
}
function syncPlayback() {
  const t = currentMediaTime();
  $("#time-current").textContent = fmtTime(t);
  positionPlayhead(t);
  updateCaptionOverlay(t);
}
$("#play-btn").addEventListener("click", togglePlay);
function togglePlay() {
  const el = state.mediaMeta?.type?.startsWith("video") ? $("#stage-video") : $("#media-audio");
  if (!el || !el.src) { toast("Add media first"); return; }
  if (el.paused) { el.play(); state.playing = true; setPlayIcon(true); }
  else { el.pause(); state.playing = false; setPlayIcon(false); }
}
function setPlayIcon(playing) {
  $("#play-btn").innerHTML = playing
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4.4" height="14" rx="1.4"/><rect x="13.6" y="5" width="4.4" height="14" rx="1.4"/></svg>'
    : '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}
$("#back-10").addEventListener("click", () => seekTo(Math.max(0, currentMediaTime() - 5)));
$("#fwd-10").addEventListener("click", () => seekTo(currentMediaTime() + 5));
function seekTo(t) {
  const el = state.mediaMeta?.type?.startsWith("video") ? $("#stage-video") : $("#media-audio");
  if (el) el.currentTime = Math.min(t, state.duration || t);
  syncPlayback();
}
$("#zoom").addEventListener("input", (e) => { state.pxPerSec = 9 * Number(e.target.value); renderRuler(); });
$("#zoom-in").addEventListener("click", () => { state.pxPerSec = Math.min(60, state.pxPerSec * 1.4); $("#zoom").value = state.pxPerSec / 9; renderRuler(); });
$("#zoom-out").addEventListener("click", () => { state.pxPerSec = Math.max(3, state.pxPerSec / 1.4); $("#zoom").value = state.pxPerSec / 9; renderRuler(); });
$("#fit-btn").addEventListener("click", () => { state.pxPerSec = Math.max(3, ($("#tracks").clientWidth - 80) / Math.max(5, state.duration)); $("#zoom").value = state.pxPerSec / 9; renderRuler(); });
$("#tracks").addEventListener("click", (e) => {
  const rect = $("#ruler").getBoundingClientRect();
  const x = e.clientX - rect.left + $("#tracks").scrollLeft - 40;
  if (e.target.closest(".track-lane") || e.target.closest(".ruler")) seekTo(Math.max(0, x / state.pxPerSec));
});

function groupLines(words) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const gap = cur ? (w.start - cur.end) : 0;
    if (!cur || cur.words.length >= 8 || gap > 0.7 || (w.start - cur.start) > 3.2) {
      if (cur) lines.push(cur);
      cur = { start: w.start, end: w.end, text: w.word, words: [w] };
    } else {
      cur.words.push(w);
      cur.text += " " + w.word;
      cur.end = Math.max(cur.end, w.end);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function renderAllCaptions(opts = {}) {
  state.lines = groupLines(state.words);
  $("#caption-stats").textContent = `${state.words.length} words · ${state.lines.length} lines`;
  if (!opts.skipEditor) renderCaptionLines();
  renderCaptionBlocks();
  updateCaptionOverlay(currentMediaTime());
}

/* ---------- Caption line editor ---------- */
function renderCaptionLines() {
  const wrap = $("#caption-lines");
  if (!wrap) return;
  wrap.innerHTML = "";
  const lc = $("#line-count");
  if (lc) lc.textContent = `${state.lines.length}`;
  state.lines.forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "caption-line";
    row.innerHTML = `<span class="cl-time">${fmtTime(line.start)}</span>
      <input type="text" value="${escHtml(line.text)}" spellcheck="false" />
      <button class="cl-split" title="Split at the largest gap">✂</button>
      <button class="cl-del" title="Delete this line">✕</button>`;
    const input = row.querySelector("input");
    input.addEventListener("input", debounce(() => editLineText(i, input.value), 400));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    row.querySelector(".cl-split").addEventListener("click", () => splitLine(i));
    row.querySelector(".cl-del").addEventListener("click", () => deleteLine(i));
    wrap.appendChild(row);
  });
}
function lineWordRange(lineWords) {
  const all = state.words;
  const first = all.indexOf(lineWords[0]);
  const last = first < 0 ? -1 : all.indexOf(lineWords[lineWords.length - 1]);
  return { first, last };
}
function persistWords() {
  api(`/api/projects/${state.projectId}/words`, { method: "PUT", body: JSON.stringify({ words: state.words }) })
    .catch(() => toast("Save failed"));
}
function editLineText(i, text) {
  const line = state.lines[i];
  if (!line) return;
  const { first, last } = lineWordRange(line.words);
  if (first < 0 || last < first) return;
  const seg = state.words.slice(first, last + 1);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return;
  const start = seg[0].start, end = seg[seg.length - 1].end;
  const span = Math.max(0.05, end - start);
  const rebuilt = tokens.map((tok, j) => ({ word: tok, start: start + (span * j) / tokens.length, end: start + (span * (j + 1)) / tokens.length }));
  state.words.splice(first, seg.length, ...rebuilt);
  state.lines = groupLines(state.words);
  $("#caption-stats").textContent = `${state.words.length} words · ${state.lines.length} lines`;
  renderCaptionBlocks();
  updateCaptionOverlay(currentMediaTime());
  persistWords();
}
function splitLine(i) {
  const line = state.lines[i];
  if (!line || line.words.length < 2) return;
  const ws = line.words;
  let best = -1, bestGap = 0.3;
  for (let k = 1; k < ws.length; k++) {
    const gap = ws[k].start - ws[k - 1].end;
    if (gap > bestGap) { bestGap = gap; best = k; }
  }
  if (best < 0) best = Math.ceil(ws.length / 2);
  // Guarantee a grouping break by forcing a gap before ws[best]
  const prevEnd = ws[best - 1].end;
  ws[best].start = Math.max(ws[best].start, prevEnd + 0.71);
  renderAllCaptions();
  persistWords();
}
function deleteLine(i) {
  const line = state.lines[i];
  if (!line) return;
  const { first, last } = lineWordRange(line.words);
  if (first < 0 || last < first) return;
  state.words.splice(first, last - first + 1);
  renderAllCaptions();
  persistWords();
}

function updateCaptionOverlay(t) {
  const layer = $("#caption-layer");
  const line = state.lines.find((l) => t >= l.start - 0.05 && t <= l.end + 0.15);
  if (!line) { layer.innerHTML = ""; state.captionCache.lineIndex = -1; return; }
  const style = state.style;
  const upper = style.uppercase ? (s) => s.toUpperCase() : (s) => s;
  const html = line.words.map((w) => {
    const on = t >= w.start - 0.04 && t <= w.end + 0.12;
    return `<span class="w${on ? " on" : ""}">${escHtml(upper(w.word))}</span>`;
  }).join(" ");
  if (state.captionCache.html !== html) {
    layer.innerHTML = `<div class="caption-box" style="font-family:'${style.font}',Impact,sans-serif;font-size:${Math.round(style.size * 0.6)}px">${html}</div>`;
    state.captionCache = { lineIndex: state.lines.indexOf(line), html };
  }
}
function applyStyleToPreview() {
  const s = state.style;
  document.documentElement.style.setProperty("--cap-accent", s.accent);
  updateCaptionOverlay(currentMediaTime());
}

/* ---------- Transcribe ---------- */
$("#transcribe-btn").addEventListener("click", transcribe);
$("#generate-captions-btn").addEventListener("click", transcribe);
async function transcribe() {
  if (!state.mediaMeta) { toast("Add media first"); return; }
  const btn = $("#generate-captions-btn");
  btn.disabled = true; btn.textContent = "Transcribing…";
  try {
    const data = await api(`/api/projects/${state.projectId}/transcribe`, { method: "POST", body: JSON.stringify({ mediaId: state.mediaMeta.id, language: "detect", engine: "whisper-large-v3-turbo" }) });
    state.words = data.words.map((w) => ({ word: w.word, start: w.start, end: w.end }));
    if ($("#roman-toggle").checked) {
      btn.textContent = "Romanizing…";
      try {
        const ai = await api(`/api/projects/${state.projectId}/caption-ai`, { method: "POST", body: JSON.stringify({ kind: "roman", words: state.words.map((w) => w.word) }) });
        if (Array.isArray(ai.words) && ai.words.length === state.words.length) {
          state.words = state.words.map((w, i) => ({ ...w, word: ai.words[i] ?? w.word }));
          await api(`/api/projects/${state.projectId}/words`, { method: "PUT", body: JSON.stringify({ words: state.words }) });
        } else {
          toast("Romanization failed — keeping original script");
        }
      } catch (err) {
        toast(`Romanization failed: ${err.message}`);
      }
    }
    renderAllCaptions();
    toast(`Transcribed with ${data.engine}`);
  } catch (err) {
    toast(`Transcription failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = "Generate captions";
  }
}

/* ---------- Presets ---------- */
const PRESETS = [
  { name: "Impact", preview: "LET'S GO", style: { font: "Anton", size: 96, base: "#ffffff", accent: "#30d158", uppercase: true } },
  { name: "Hinglish", preview: "yeh sunn na", style: { font: "Archivo Black", size: 88, base: "#fff7e0", accent: "#ffd60a", uppercase: false } },
  { name: "Neon", preview: "SABD SAAF", style: { font: "Bebas Neue", size: 100, base: "#a5f3fc", accent: "#22d3ee", uppercase: true } },
  { name: "Classic", preview: "shukriya", style: { font: "Rubik", size: 72, base: "#ffffff", accent: "#86868b", uppercase: false } },
  { name: "Hormozi", preview: "LISTEN.", style: { font: "Bebas Neue", size: 120, base: "#fef08a", accent: "#facc15", uppercase: true } },
  { name: "Midnight", preview: "2am ideas", style: { font: "Luckiest Guy", size: 78, base: "#e2e8f0", accent: "#a78bfa", uppercase: false } },
];
function renderPresets() {
  const grid = $("#preset-grid");
  grid.innerHTML = "";
  for (const p of PRESETS) {
    const el = document.createElement("button");
    el.className = "preset-card";
    el.innerHTML = `<span class="preview" style="font-family:'${p.style.font}'">${escHtml(p.preview)}</span>${escHtml(p.name)}`;
    el.addEventListener("click", () => {
      state.style = { ...state.style, ...p.style };
      $("#font-select").value = state.style.font;
      $("#font-size").value = state.style.size;
      $("#accent-color").value = state.style.accent;
      $("#base-color").value = state.style.base;
      $("#uppercase-toggle").checked = state.style.uppercase;
      applyStyleToPreview();
      styleSave();
      toast(`Preset “${p.name}” applied`);
    });
    grid.appendChild(el);
  }
}

/* ---------- Trim / auto-edit ---------- */
$("#auto-edit-btn").addEventListener("click", async () => {
  if (!state.words.length) { toast("Generate captions first"); return; }
  const btn = $("#auto-edit-btn");
  const note = $("#auto-edit-note");
  btn.disabled = true; btn.textContent = "Editing…"; note.textContent = "";
  try {
    const data = await api(`/api/projects/${state.projectId}/caption-ai`, { method: "POST", body: JSON.stringify({
      kind: "auto-edit",
      words: state.words.map((w) => w.word),
      options: { aggressionLevel: Number($("#aggression").value), removeFillers: $("#opt-filler").checked, removeRepetitions: $("#opt-rep").checked, removeOffTopic: $("#opt-offtopic").checked },
    }) });
    if (Array.isArray(data.keepIndices) && data.keepIndices.length) {
      state.words = state.words.filter((_, i) => data.keepIndices.includes(i));
      await api(`/api/projects/${state.projectId}/words`, { method: "PUT", body: JSON.stringify({ words: state.words }) });
      renderAllCaptions();
      note.textContent = `Applied AI trim — ${state.words.length} words kept.`;
    } else {
      note.textContent = "AI returned no cuts (or the key is missing — see .env).";
    }
  } catch (err) { note.textContent = `Auto-edit failed: ${err.message}`; }
  finally { btn.disabled = false; btn.textContent = "Auto-edit captions"; }
});

$("#detect-silence-btn").addEventListener("click", () => {
  if (!state.peaks) { toast("Decode the audio first (media must be added)"); return; }
  detectSilences(Number($("#silence-threshold").value) / 100, Number($("#silence-min").value));
});
$("#clear-cuts-btn").addEventListener("click", () => { state.cuts = []; renderCuts(); $("#silence-note").textContent = "Cuts cleared."; });

function detectSilences(threshold, minMs) {
  const peaks = state.peaks, n = peaks.length;
  const hopSec = state.duration / n;
  const silences = [];
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    const silent = peaks[i] < threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      const start = runStart * hopSec, end = i * hopSec;
      if (end - start >= minMs / 1000) silences.push({ start, end });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    const start = runStart * hopSec, end = state.duration;
    if (end - start >= minMs / 1000) silences.push({ start, end });
  }
  state.cuts = silences;
  renderCuts();
  $("#silence-note").textContent = silences.length
    ? `${silences.length} silences found · ${silences.reduce((a, c) => a + (c.end - c.start), 0).toFixed(1)}s will be cut`
    : "No silences above that threshold.";
  api(`/api/projects/${state.projectId}/silences`, { method: "PUT", body: JSON.stringify({ cuts: silences }) }).catch(() => {});
}

/* ---------- Style panel ---------- */
$("#font-select").addEventListener("change", (e) => { state.style.font = e.target.value; applyStyleToPreview(); styleSave(); });
$("#font-size").addEventListener("input", (e) => { state.style.size = Number(e.target.value); applyStyleToPreview(); styleSave(); });
$("#accent-color").addEventListener("input", (e) => { state.style.accent = e.target.value; updateCaptionOverlay(currentMediaTime()); styleSave(); });
$("#base-color").addEventListener("input", (e) => { state.style.base = e.target.value; updateCaptionOverlay(currentMediaTime()); styleSave(); });
$("#uppercase-toggle").addEventListener("change", (e) => { state.style.uppercase = e.target.checked; updateCaptionOverlay(currentMediaTime()); styleSave(); });
$("#doc-name").addEventListener("input", () => { setSaveState("Saving…"); styleSave(); });
$$('[data-aspect]').forEach((b) => b.addEventListener("click", () => setAspect(b.dataset.aspect)));
function setAspect(a) {
  state.aspect = a;
  $("#ratio-label").textContent = a;
  $("#stage").dataset.aspect = a;
  $$('[data-aspect]').forEach((b) => b.classList.toggle("active", b.dataset.aspect === a));
  styleSave();
}
$("#ratio-chip").addEventListener("click", () => setAspect(state.aspect === "9:16" ? "16:9" : state.aspect === "16:9" ? "1:1" : "9:16"));

/* ---------- Panels ---------- */
$$(".rail-btn").forEach((btn) => btn.addEventListener("click", () => setPanel(btn.dataset.tool)));
function setPanel(name) {
  state.activePanel = name;
  $$(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
  $$(".panel-page").forEach((p) => p.classList.toggle("hidden", p.dataset.page !== name));
  $("#panel-title").textContent = $(`.rail-btn[data-tool="${name}"]`)?.dataset.label ?? name;
}

/* ---------- Export ---------- */
$("#export-btn").addEventListener("click", () => $("#export-modal").classList.remove("hidden"));
$("#close-modal-btn").addEventListener("click", () => $("#export-modal").classList.add("hidden"));
$("#export-modal").addEventListener("click", (e) => { if (e.target.id === "export-modal") $("#export-modal").classList.add("hidden"); });
let exportAspect = "9:16", exportMode = "with-captions";
$$('[data-export-aspect]').forEach((b) => b.addEventListener("click", () => { exportAspect = b.dataset.exportAspect; $$('[data-export-aspect]').forEach((x) => x.classList.toggle("active", x === b)); }));
$$('[data-export-mode]').forEach((b) => b.addEventListener("click", () => { exportMode = b.dataset.exportMode; $$('[data-export-mode]').forEach((x) => x.classList.toggle("active", x === b)); }));

$("#start-export-btn").addEventListener("click", async () => {
  if (!state.mediaMeta) { toast("Add media first"); return; }
  $("#start-export-btn").classList.add("hidden");
  $("#export-progress").classList.remove("hidden");
  $("#export-done").classList.add("hidden");
  try {
    const { jobId } = await api(`/api/projects/${state.projectId}/export`, { method: "POST", body: JSON.stringify({
      aspect: exportAspect,
      captions: exportMode !== "none",
      mode: exportMode === "captions-only" ? "captions-only" : "video",
      cuts: state.applyCuts ? state.cuts : [],
      style: state.style,
    }) });
    pollExport(jobId);
  } catch (err) {
    toast(`Export failed: ${err.message}`);
    $("#start-export-btn").classList.remove("hidden");
    $("#export-progress").classList.add("hidden");
  }
});
async function pollExport(jobId) {
  const fill = $("#export-fill"), stage = $("#export-stage"), pct = $("#export-pct");
  for (;;) {
    await new Promise((r) => setTimeout(r, 800));
    let job;
    try { job = await api(`/api/export/${jobId}`); } catch { continue; }
    fill.style.width = `${Math.round((job.progress || 0) * 100)}%`;
    pct.textContent = `${Math.round((job.progress || 0) * 100)}%`;
    stage.textContent = job.stage || "Rendering…";
    if (job.status === "done") {
      $("#export-progress").classList.add("hidden");
      $("#export-done").classList.remove("hidden");
      $("#export-download").href = `/api/export/${jobId}/file`;
      return;
    }
    if (job.status === "failed") { toast(`Export failed: ${job.error || "unknown error"}`); $("#export-progress").classList.add("hidden"); $("#start-export-btn").classList.remove("hidden"); return; }
  }
}

/* ---------- SRT + captions-only exports ---------- */
function downloadSrt() {
  if (!state.projectId) return;
  if (!state.words.length) { toast("Generate captions first"); return; }
  window.location.assign(`/api/projects/${state.projectId}/srt`);
}
$("#srt-download-btn").addEventListener("click", downloadSrt);
$("#modal-srt-btn").addEventListener("click", downloadSrt);
$("#captions-only-export-btn").addEventListener("click", () => {
  exportMode = "captions-only";
  $$('[data-export-mode]').forEach((x) => x.classList.toggle("active", x.dataset.exportMode === "captions-only"));
  $("#export-modal").classList.remove("hidden");
});
$("#apply-cuts-toggle").addEventListener("change", (e) => { state.applyCuts = e.target.checked; });

/* ---------- Wiring ---------- */
$("#back-btn").addEventListener("click", showDashboard);
$("#new-project-btn").addEventListener("click", createProject);
$("#empty-new-btn").addEventListener("click", createProject);
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key.toLowerCase() === "n" && !dashboardEl.classList.contains("hidden")) createProject();
  else if (e.key.toLowerCase() === "b" && e.target.id !== "doc-name") showDashboard();
  else if (e.key === "Escape") $("#export-modal").classList.add("hidden");
  else if (["1","2","3","4","5"].includes(e.key)) setPanel(["media","text","trim","silence","style"][Number(e.key) - 1]);
});
$("#stage-video").addEventListener("ended", () => { state.playing = false; setPlayIcon(false); });
$("#media-audio").addEventListener("ended", () => { state.playing = false; setPlayIcon(false); });

showDashboard().catch((err) => toast(`Failed to load projects: ${err.message}`));
