// Generate an ASS subtitle file from word-timed captions for ffmpeg burn-in.
// Whole line in base color; each active word is re-drawn bigger + accent-colored
// for exactly its own window. Explicit wrapping fits Bebas/Anton at PlayResX.

const ESC = (s) =>
  String(s ?? "")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ");

export function msToAss(ms) {
  const cs = Math.floor(ms / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const centi = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(centi).padStart(2, "0")}`;
}

export function groupWords(words, { maxWords = 8, maxGapMs = 700, maxLineMs = 3200 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const start = Math.round((w.start ?? 0) * 1000);
    const end = Math.round((w.end ?? w.start ?? 0) * 1000);
    const gap = cur ? start - cur.end : 0;
    if (!cur || cur.words.length >= maxWords || gap > maxGapMs || (start - cur.start) > maxLineMs) {
      if (cur) lines.push(cur);
      cur = { start, end, words: [{ word: w.word, start, end }] };
    } else {
      cur.words.push({ word: w.word, start, end });
      cur.end = Math.max(cur.end, end);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Greedy wrap to visual rows of at most `limit` characters.
function wrapWords(words, limit) {
  const rows = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    const add = (cur.length ? 1 : 0) + w.word.length;
    if (len + add > limit && cur.length) {
      rows.push(cur);
      cur = [w];
      len = w.word.length;
    } else {
      cur.push(w);
      len += add;
    }
  }
  if (cur.length) rows.push(cur);
  return rows;
}

// style = { font, sizePct, base, accent, stroke, uppercase }
export function buildAss({ words, canvas = { w: 1080, h: 1920 }, accent = "&H0000FF00&", baseColor = "&H00FFFFFF&", font = "Bebas Neue", size = 96, stroke = 3, popScale = 112, marginBottom = 300 }) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${canvas.w}
PlayResY: ${canvas.h}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop,${font},${size},${baseColor},&H000000FF,&H00000000,&H80000000,1,${stroke},2,2,40,40,${marginBottom},1
Style: PopOn,${font},${size},${accent},&H000000FF,&H00000000,&H80000000,1,${stroke},2,2,40,40,${marginBottom},1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
`;
  const lineCharLimit = Math.max(16, Math.floor(canvas.w / (size * 0.52)));
  const events = [];
  const lines = groupWords(words);
  for (const line of lines) {
    const rows = wrapWords(line.words, lineCharLimit);
    const render = (styleFn) =>
      rows.map((row) => row.map((w) => styleFn(w)).join(" ")).join("\\N");
    const baseLine = render((w) => ESC(w.word));
    events.push(`Dialogue: 0,${msToAss(line.start)},${msToAss(line.end)},Pop,,40,40,,,${baseLine}`);
    for (const w of line.words) {
      const activeLine = render((x) => {
        const word = ESC(x.word);
        if (x.start === w.start && x.end === w.end) {
          return `{\\fsp0}{\\c${accent}}{\\fscx112\\fscy112}${word}{\\c${baseColor}}{\\fscx100\\fscy100}`;
        }
        return word;
      });
      events.push(`Dialogue: 1,${msToAss(w.start)},${msToAss(w.end)},PopOn,,40,40,,,${activeLine}`);
    }
  }
  return head + events.join("\n") + "\n";
}
