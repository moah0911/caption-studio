// Render worker: trims, scales/crops to aspect, burns ASS captions, encodes MP4.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import db, { EXPORTS_DIR, DATA_DIR, MEDIA_DIR } from "./db.js";
import { FFMPEG, FFPROBE } from "./ffmpeg-path.js";
import { buildAss } from "./subtitles.js";

const CANVAS = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "1:1": { w: 1080, h: 1080 },
};

const setJob = (id, patch) =>
  db.prepare(`UPDATE export_jobs SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(patch), Date.now(), id);

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const hexToAss = (hex) => {
  const h = String(hex || "#ffffff").replace("#", "");
  const to2 = (n) => n.toString(16).padStart(2, "0").toUpperCase();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "f").slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `&H00${to2(b)}${to2(g)}${to2(r)}&`;
};
const ffprobeDuration = (file) => new Promise((resolve) => {
  const p = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("close", () => resolve(Number.parseFloat(out.trim()) || null));
  p.on("error", () => resolve(null));
});

function keepSegments(duration, cuts) {
  const sorted = [...cuts].filter((c) => c.end_s > c.start_s).sort((a, b) => a.start_s - b.start_s);
  const keep = [];
  let cursor = 0;
  for (const c of sorted) {
    const s = Math.max(0, c.start_s), e = Math.min(duration, c.end_s);
    if (s > cursor + 0.05) keep.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration - 0.05) keep.push([cursor, duration]);
  if (keep.length === 0) keep.push([0, duration]);
  return keep;
}
// Shift word timestamps through the keep-segments mapping.
function remapWords(words, keep) {
  const out = [];
  let offset = 0;
  for (const [s, e] of keep) {
    for (const w of words) {
      const ws = Number(w.start), we = Number(w.end);
      if (we <= s || ws >= e) continue;
      out.push({
        word: w.word,
        start: Math.max(0, Math.max(ws, s) - s + offset),
        end: Math.max(0, Math.min(we, e) - s + offset),
      });
    }
    offset += e - s;
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function startExportJob({ jobId, projectId, media, aspect, captionsEnabled, wordsJson, cuts, style = {}, mode = "video" }) {
  const mediaFile = path.join(MEDIA_DIR, media.id + path.extname(media.path || media.filename));
  if (!fs.existsSync(mediaFile)) throw new Error("media file missing on disk");
  const canvas = CANVAS[aspect] ?? CANVAS["9:16"];
  // "captions-only" renders captions on a black canvas with the media's audio
  const isVideo = (media.type || "").startsWith("video") && mode !== "captions-only";
  const totalDuration = (await ffprobeDuration(mediaFile)) ?? media.duration ?? 0;
  const keep = cuts.length ? keepSegments(totalDuration, cuts) : [[0, totalDuration]];
  const keptDuration = keep.reduce((a, [s, e]) => a + (e - s), 0);
  const outFile = path.join(EXPORTS_DIR, `${jobId}.mp4`);
  const assFile = path.join(DATA_DIR, `captions-${jobId}.ass`);

  setJob(jobId, { status: "running", stage: "Preparing trims", progress: 0.05 });

  // Build caption ASS (remapped through cuts)
  if (captionsEnabled && wordsJson) {
    try {
      const words = JSON.parse(wordsJson);
      const remapped = cuts.length ? remapWords(words, keep) : words.map((w) => ({ ...w }));
      const marginBottom = Math.round(canvas.h * 0.17);
      const ass = buildAss({
        words: remapped,
        canvas,
        accent: hexToAss(style.accent || "#30d158"),
        baseColor: hexToAss(style.base || "#ffffff"),
        font: style.font || "Bebas Neue",
        size: Math.round((Number(style.size) || 96) * (canvas.h / 1920)),
        stroke: 3,
        marginBottom,
      });
      fs.writeFileSync(assFile, ass, "utf8");
    } catch (e) {
      console.error("ass generation failed:", e);
      fs.rm(assFile, { force: true }, () => {});
    }
  }
  const hasCaptions = captionsEnabled && fs.existsSync(assFile);
  const fontsDir = path.join(process.cwd(), "assets", "fonts").replace(/\\/g, "/").replace(/:/g, "\\:");

  const args = ["-y"];
  if (isVideo) {
    args.push("-i", mediaFile);
  } else {
    // audio-only: generate background
    args.push("-f", "lavfi", "-i", `color=c=0x111318:s=${canvas.w}x${canvas.h}:r=30`);
    args.push("-i", mediaFile);
  }

  const vfParts = [`scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase`, `crop=${canvas.w}:${canvas.h}`, "setsar=1", "fps=30"];
  if (hasCaptions) vfParts.push(`subtitles='${assFile.replace(/\\/g, "/").replace(/:/g, "\\:")}':fontsdir='${fontsDir}'`);
  const vFilter = vfParts.join(",");

  const isFull = keep.length === 1 && keep[0][0] === 0 && Math.abs(keep[0][1] - totalDuration) < 0.01;
  if (isFull) {
    // no cuts — simple filter chain
    args.push("-vf", vFilter);
    if (isVideo) args.push("-map", "0:v:0", "-map", "0:a?");
    else args.push("-map", "0:v:0", "-map", "1:a:0");
  } else {
    // trim/concat via filter_complex
    const parts = [];
    for (let i = 0; i < keep.length; i++) {
      const [s, e] = keep[i];
      if (isVideo) {
        parts.push(`[0:v]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
        parts.push(`[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        parts.push(`[1:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
    if (isVideo) {
      parts.push(keep.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${keep.length}:v=1:a=1[vc][ac]`);
      parts.push(`[vc]${vFilter}[v]`);
      args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[ac]");
    } else {
      parts.push(keep.map((_, i) => `[a${i}]`).join("") + `concat=n=${keep.length}:v=0:a=1[ac]`);
      parts.push(`[0:v]${vFilter}[v]`);
      args.push("-filter_complex", parts.join(";"), "-map", "[v]", "-map", "[ac]");
    }
  }

  args.push(
    "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-shortest",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outFile
  );

  setJob(jobId, { stage: "Encoding", progress: 0.1 });

  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 120000) stderr = stderr.slice(-80000); });
    p.stdout.on("data", (d) => {
      const line = d.toString();
      const m = /out_time_ms=(\d+)/.exec(line);
      if (m && keptDuration > 0) {
        const doneSec = Number(m[1]) / 1e6;
        setJob(jobId, { stage: "Encoding", progress: 0.1 + 0.85 * clamp01(doneSec / keptDuration) });
      }
    });
    const timeout = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ffmpeg timed out")); }, 30 * 60 * 1000);
    p.on("error", (e) => { clearTimeout(timeout); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split("\n").slice(-8).join("\n") || `ffmpeg exited ${code}`));
    });
  });

  fs.rm(assFile, { force: true }, () => {});
  setJob(jobId, { status: "done", stage: "Done", progress: 1, output_path: `${jobId}.mp4` });
}
