// CapCut Studio — local single-user server (Node 24, zero npm deps)
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import db, { DATA_DIR, MEDIA_DIR, EXPORTS_DIR } from "./db.js"; import { FFMPEG, FFPROBE } from "./ffmpeg-path.js";
import { transcribe, captionAi, isConfigured } from "./groq.js";
import { startExportJob } from "./export.js";

const PUBLIC = path.join(process.cwd(), "public");
const PORT = Number(process.env.PORT || 4269);

// Load .env (tiny parser, no deps)
try {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
} catch {}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".woff2": "font/woff2",
};

const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
};
const sendError = (res, code, msg) => sendJson(res, code, { error: String(msg).slice(0, 800) });
const readBody = (req, cap = 25 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > cap) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const readJson = async (req) => {
  const buf = await readBody(req);
  try { return buf.length ? JSON.parse(buf.toString("utf8")) : {}; }
  catch { throw new Error("invalid JSON body"); }
};
const sanitizeName = (n) => String(n || "").replace(/[^\w.\- ]+/g, "_").trim().slice(0, 120) || "file";
const validAspect = (a) => ["9:16", "16:9", "1:1"].includes(a) ? a : "9:16";
const validHex = (c) => (typeof c === "string" && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) ? c : null;
const resolveMediaPath = (m) => {
  const p = path.join(MEDIA_DIR, m.id + path.extname(m.path || m.filename || ""));
  return fs.existsSync(p) ? p : null;
};
const getParam = (urlObj, key, def) => urlObj.searchParams.get(key) ?? def;

function runFfmpeg(args, { timeoutMs = 20 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(stderr) : reject(new Error(stderr.trim().split("\n").slice(-6).join("\n") || `ffmpeg exited ${code}`)); });
  });
}
async function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Number.parseFloat(out.trim()) || null));
    p.on("error", () => resolve(null));
  });
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
const matchRoute = (method, urlPath) => {
  const segs = urlPath.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const pSegs = r.pattern.split("/").filter(Boolean);
    if (pSegs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(":")) params[pSegs[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (pSegs[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
};

/* ---------- Projects ---------- */
route("GET", "/api/projects", (req, res) => {
  const rows = db.prepare(`SELECT p.id, p.name, p.ratio AS aspect, p.updated_at,
      (SELECT COUNT(*) FROM media m WHERE m.project_id = p.id) AS media_count,
      (SELECT COUNT(*) FROM captions c WHERE c.project_id = p.id) AS caption_count
    FROM projects p ORDER BY p.updated_at DESC`).all();
  sendJson(res, 200, rows);
});
route("POST", "/api/projects", async (req, res) => {
  const { name } = await readJson(req);
  const id = randomUUID();
  const now = Date.now();
  db.prepare("INSERT INTO projects (id, name, ratio, bg_color, caption_style, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, sanitizeName(name).slice(0, 80) || "Untitled caption", "9:16", "#111318", "{}", now, now);
  sendJson(res, 201, { id });
});
const getProjectOr404 = (id) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
route("GET", "/api/projects/:id", (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const media = db.prepare("SELECT * FROM media WHERE project_id = ? ORDER BY created_at").all(id);
  const transcription = db.prepare("SELECT * FROM transcriptions WHERE project_id = ?").get(id);
  const cuts = db.prepare("SELECT * FROM silence_cuts WHERE project_id = ? ORDER BY start_s").all(id);
  sendJson(res, 200, { project, media, transcription: transcription ?? null, cuts });
});
route("PUT", "/api/projects/:id", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const body = await readJson(req);
  const name = body.name !== undefined ? sanitizeName(body.name).slice(0, 80) || project.name : project.name;
  const aspect = body.aspect !== undefined ? validAspect(body.aspect) : project.ratio;
  const style = body.caption_style !== undefined ? (typeof body.caption_style === "string" ? body.caption_style : JSON.stringify(body.caption_style)) : project.caption_style;
  db.prepare("UPDATE projects SET name = ?, ratio = ?, caption_style = ?, updated_at = ? WHERE id = ?").run(name, aspect, style, Date.now(), id);
  sendJson(res, 200, { ok: true });
});
route("DELETE", "/api/projects/:id", (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const media = db.prepare("SELECT * FROM media WHERE project_id = ?").all(id);
  for (const m of media) {
    const p = path.join(MEDIA_DIR, m.id + path.extname(m.path || m.filename || ""));
    fs.rm(p, { force: true }, () => {});
  }
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  sendJson(res, 200, { ok: true });
});

/* ---------- Media ---------- */
route("POST", "/api/projects/:id/media", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const url = new URL(req.url, "http://x");
  const filename = sanitizeName(getParam(url, "filename", "media"));
  const type = String(getParam(url, "type", "application/octet-stream")).slice(0, 120);
  const ext = path.extname(filename) || (type.startsWith("audio") ? ".mp3" : ".mp4");
  const mid = randomUUID();
  const target = path.join(MEDIA_DIR, mid + ext);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 4 * 1024 * 1024 * 1024) { out.destroy(); req.destroy(new Error("media too large")); } });
    req.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
    req.on("error", reject);
  });
  const stat = fs.statSync(target);
  const duration = await probeDuration(target);
  const sha256 = await new Promise((resolve) => {
    const h = createHash("sha256"); fs.createReadStream(target).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });
  db.prepare("INSERT INTO media (id, project_id, filename, type, duration, size, path, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(mid, id, filename, type, duration, stat.size, target, sha256, Date.now());
  sendJson(res, 201, { id: mid, filename, size: stat.size, duration, type });
});
route("GET", "/api/projects/:id/media/:mid", (req, res, { id, mid }) => {
  const m = db.prepare("SELECT * FROM media WHERE id = ? AND project_id = ?").get(mid, id);
  if (!m) return sendError(res, 404, "media not found");
  const file = path.join(MEDIA_DIR, m.id + path.extname(m.path || m.filename));
  if (!fs.existsSync(file)) return sendError(res, 404, "media file missing");
  const stat = fs.statSync(file);
  const range = req.headers.range;
  const type = m.type || MIME[path.extname(file)] || "application/octet-stream";
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = Number(match?.[1] || 0), end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); return res.end(); }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }
});
route("DELETE", "/api/projects/:id/media/:mid", (req, res, { id, mid }) => {
  const m = db.prepare("SELECT * FROM media WHERE id = ? AND project_id = ?").get(mid, id);
  if (!m) return sendError(res, 404, "media not found");
  fs.rm(path.join(MEDIA_DIR, m.id + path.extname(m.path || m.filename)), { force: true }, () => {});
  db.prepare("DELETE FROM media WHERE id = ?").run(mid);
  sendJson(res, 200, { ok: true });
});

/* ---------- Transcription ---------- */
route("POST", "/api/projects/:id/transcribe", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const { mediaId, language = "detect", engine = "whisper-large-v3-turbo" } = await readJson(req);
  const m = db.prepare("SELECT * FROM media WHERE id = ? AND project_id = ?").get(mediaId, id);
  if (!m) return sendError(res, 404, "media not found");
  const file = path.join(MEDIA_DIR, m.id + path.extname(m.path || m.filename));
  if (!fs.existsSync(file)) return sendError(res, 404, "media file missing");

  const now = Date.now();
  if (!isConfigured()) {
    // Transcription always goes through the Groq API — fail loudly instead of
    // fabricating captions with a built-in demo.
    return sendError(res, 503, "GROQ_API_KEY is not configured. Add it to .env (see .env.example) and restart the server.");
  }
  // Convert whatever we have to 16 kHz mono WAV for whisper.
  const wav = path.join(DATA_DIR, `tmp-${randomUUID()}.wav`);
  try {
    await runFfmpeg(["-y", "-i", file, "-ac", "1", "-ar", "16000", "-hide_banner", wav], { timeoutMs: 10 * 60 * 1000 });
    const bytes = fs.readFileSync(wav);
    const result = await transcribe(bytes, { filename: "audio.wav", language: language === "auto" ? "detect" : language, seconds: m.duration });
    db.prepare("INSERT INTO transcriptions (project_id, language, engine, text, words, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET language=excluded.language, engine=excluded.engine, text=excluded.text, words=excluded.words, created_at=excluded.created_at")
      .run(id, result.language, engine, result.text, JSON.stringify(result.words), now);
    sendJson(res, 200, { engine, language: result.language, text: result.text, words: result.words });
  } finally {
    fs.rm(wav, { force: true }, () => {});
  }
});
route("PUT", "/api/projects/:id/words", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const { words } = await readJson(req);
  if (!Array.isArray(words)) return sendError(res, 400, "words must be an array");
  const clean = words.filter((w) => w && typeof w.word === "string" && isFinite(w.start) && isFinite(w.end))
    .slice(0, 50000)
    .map((w) => ({ word: String(w.word).slice(0, 120), start: Number(w.start), end: Number(w.end) }));
  const existing = db.prepare("SELECT engine FROM transcriptions WHERE project_id = ?").get(id);
  const text = clean.map((w) => w.word).join(" ");
  db.prepare("INSERT INTO transcriptions (project_id, language, engine, text, words, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET text=excluded.text, words=excluded.words, created_at=excluded.created_at")
    .run(id, "edited", existing?.engine || "edited", text, JSON.stringify(clean), Date.now());
  sendJson(res, 200, { ok: true, words: clean });
});
route("PUT", "/api/projects/:id/silences", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const { cuts } = await readJson(req);
  const media = db.prepare("SELECT id FROM media WHERE project_id = ? ORDER BY created_at LIMIT 1").get(id);
  const clean = (Array.isArray(cuts) ? cuts : [])
    .filter((c) => c && isFinite(c.start) && isFinite(c.end) && c.end > c.start)
    .slice(0, 2000);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM silence_cuts WHERE project_id = ?").run(id);
    const ins = db.prepare("INSERT INTO silence_cuts (id, project_id, media_id, start_s, end_s, created_at) VALUES (?,?,?,?,?,?)");
    for (const c of clean) ins.run(randomUUID(), id, media?.id ?? null, Number(c.start), Number(c.end), Date.now());
  });
  tx();
  sendJson(res, 200, { ok: true, cuts: clean });
});
route("POST", "/api/projects/:id/caption-ai", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const body = await readJson(req);
  try {
    const out = await captionAi(body);
    sendJson(res, 200, out);
  } catch (e) {
    sendError(res, e.status === 404 ? 404 : 502, e.message);
  }
});

/* ---------- SRT export ---------- */
function srtTime(s) {
  const ms = Math.max(0, Math.round((s ?? 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(mmm).padStart(3, "0")}`;
}
function groupWordsSrt(words, { maxWords = 8, maxGapS = 0.7, maxLineS = 3.2 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const start = Number(w.start ?? 0);
    const end = Number(w.end ?? start);
    const gap = cur ? start - cur.end : 0;
    if (!cur || cur.words.length >= maxWords || gap > maxGapS || (start - cur.start) > maxLineS) {
      if (cur) lines.push(cur);
      cur = { start, end, text: String(w.word), words: [w] };
    } else {
      cur.words.push(w);
      cur.text += " " + w.word;
      cur.end = Math.max(cur.end, end);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
route("GET", "/api/projects/:id/srt", (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const transcription = db.prepare("SELECT words FROM transcriptions WHERE project_id = ?").get(id);
  if (!transcription) return sendError(res, 404, "no transcription yet — generate captions first");
  const lines = groupWordsSrt(JSON.parse(transcription.words));
  const body = lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join("\n");
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="captions.srt"` });
  res.end(body);
});

/* ---------- Export ---------- */
route("POST", "/api/projects/:id/export", async (req, res, { id }) => {
  const project = getProjectOr404(id);
  if (!project) return sendError(res, 404, "project not found");
  const media = db.prepare("SELECT * FROM media WHERE project_id = ? ORDER BY created_at LIMIT 1").get(id);
  if (!media) return sendError(res, 400, "add media before exporting");
  const body = await readJson(req);
  const aspect = validAspect(body.aspect);
  const style = body.style && typeof body.style === "object" ? body.style : {};
  if (style.base) style.base = validHex(style.base) ?? "#ffffff";
  if (style.accent) style.accent = validHex(style.accent) ?? "#30d158";
  const transcription = db.prepare("SELECT words FROM transcriptions WHERE project_id = ?").get(id);
  const overrideCuts = Array.isArray(body.cuts) ? body.cuts : null;
  let cutRows;
  if (overrideCuts) {
    cutRows = overrideCuts.filter((c) => c && isFinite(c.start) && isFinite(c.end) && c.end > c.start).map((c) => ({ start_s: Number(c.start), end_s: Number(c.end) }));
  } else {
    cutRows = db.prepare("SELECT start_s, end_s FROM silence_cuts WHERE project_id = ? ORDER BY start_s").all(id);
  }
  const jobId = randomUUID();
  const now = Date.now();
  const mode = body.mode === "captions-only" ? "captions-only" : "video";
  db.prepare("INSERT INTO export_jobs (id, project_id, status, progress, stage, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(jobId, id, "queued", 0, "queued", JSON.stringify({ aspect, captions: Boolean(body.captions), style, cutCount: cutRows.length, mode }), now, now);
  startExportJob({
    jobId, projectId: id, media, aspect,
    captionsEnabled: Boolean(body.captions),
    wordsJson: transcription?.words ?? null,
    cuts: cutRows, style, mode,
  }).catch((e) => {
    console.error("export job crashed:", e);
    db.prepare("UPDATE export_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(String(e.message || e).slice(0, 1000), Date.now(), jobId);
  });
  sendJson(res, 202, { jobId });
});
route("GET", "/api/export/:jobId", (req, res, { jobId }) => {
  const job = db.prepare("SELECT * FROM export_jobs WHERE id = ?").get(jobId);
  if (!job) return sendError(res, 404, "job not found");
  sendJson(res, 200, { status: job.status, progress: job.progress, stage: job.stage, error: job.error, output: job.status === "done" ? `/api/export/${jobId}/file` : null });
});
route("GET", "/api/export/:jobId/file", (req, res, { jobId }) => {
  const job = db.prepare("SELECT * FROM export_jobs WHERE id = ?").get(jobId);
  if (!job || job.status !== "done" || !job.output_path) return sendError(res, 404, "export not ready");
  const file = path.join(EXPORTS_DIR, path.basename(job.output_path));
  if (!fs.existsSync(file)) return sendError(res, 404, "export file missing");
  res.writeHead(200, { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="${path.basename(file)}"` });
  fs.createReadStream(file).pipe(res);
});

/* ---------- Health ---------- */
route("GET", "/api/health", (req, res) => sendJson(res, 200, { ok: true, groq: isConfigured(), time: Date.now() }));

/* ---------- Static ---------- */
function serveStatic(req, res, urlPath) {
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(PUBLIC, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC)) return sendError(res, 403, "forbidden");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendError(res, 404, "not found");
  const type = MIME[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const m = matchRoute(req.method, url.pathname);
      if (!m) return sendError(res, 404, "unknown endpoint");
      await m.handler(req, res, m.params);
    } else {
      serveStatic(req, res, decodeURIComponent(url.pathname));
    }
  } catch (e) {
    console.error("request error:", e);
    if (!res.headersSent) sendError(res, 500, e.message || "internal error");
    else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Caption Studio listening on http://localhost:${PORT}`);
  console.log("Groq:", isConfigured() ? "GROQ_API_KEY loaded — transcription always via Groq API" : "GROQ_API_KEY missing — transcription will fail until .env is configured (see .env.example)");
});
