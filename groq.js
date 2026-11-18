// Groq API client (zero dependencies, Node 24 fetch).
// ASR:  whisper-large-v3-turbo -> verbose_json word timestamps (works on this key)
// Chat: qwen/qwen3.8-27b      -> romanize / translate / auto-edit (only key-capable model; gpt-oss and smaller Llama cannot emit Indic glyphs)

const API = "https://api.groq.com/openai/v1";

export function isConfigured() {
  return Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim().length > 0);
}

async function groqFetch(path, options = {}) {
  if (!isConfigured()) throw new Error("GROQ_API_KEY is not set. Add it to .env (see .env.example).");
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY.trim()}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Groq API error ${res.status}${res.status === 429 ? " (rate limit)" : ""}: ${body.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// Read file -> FormData-ish multipart body by hand (no deps).
function multipartBody(parts) {
  const boundary = "----fluxocut" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"` +
      (part.filename ? `; filename="${part.filename}"` : "") +
      (part.filename ? `\r\nContent-Type: ${part.contentType || "application/octet-stream"}` : "") +
      `\r\n\r\n`));
    chunks.push(part.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

// Transcribe audio/video file bytes -> { text, language, words: [{ word, start, end }] }
// language: optional ISO code, or "detect" / omitted for auto-detect (Hindi/Telugu/etc. Roman-friendly).
export async function transcribe(fileBytes, { filename = "audio.wav", language, seconds } = {}) {
  const parts = [
    { name: "model", data: Buffer.from("whisper-large-v3-turbo") },
    { name: "file", filename, contentType: "audio/wav", data: fileBytes },
    { name: "response_format", data: Buffer.from("verbose_json") },
    { name: "timestamp_granularities[]", data: Buffer.from("word") },
    { name: "temperature", data: Buffer.from("0") },
  ];
  if (language && language !== "detect" && language !== "auto") {
    parts.push({ name: "language", data: Buffer.from(String(language)) });
  }
  const { body, boundary } = multipartBody(parts);
  const res = await groqFetch("/audio/transcriptions", {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const json = await res.json();
  const words = (json.words || []).map((w) => ({
    word: String(w.word ?? w.text ?? "").trim(),
    start: Number(w.start ?? 0),
    end: Number(w.end ?? 0),
  })).filter((w) => w.word);
  return {
    text: json.text || words.map((w) => w.word).join(" "),
    language: json.language || language || "auto",
    duration: typeof json.duration === "number" ? json.duration : seconds ?? null,
    words,
  };
}

const CHAT_MODEL = "qwen/qwen3.8-27b";

async function chat(system, user, { temperature = 0.2, maxTokens = 2048 } = {}) {
  const res = await groqFetch("/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: String(user) },
      ],
    }),
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

const ROMAN_WORDS_SYSTEM = `You are a transliterator for short-form captions.
Convert each numbered item from Devanagari/native script to Roman-script "Hinglish" (Latin alphabet, casual spoken spelling) WITHOUT changing order, count, or meaning.
Input is a numbered list like "0: शब्द". Return ONLY a JSON array of strings in the same order — item count must exactly match. No commentary, no markdown fences.`;

const TRANSLATE_SYSTEM = `You are a caption translator.
Translate the given short-form caption line into the target language, keeping it short, punchy and speakable.
Return ONLY the translated text, nothing else.`;

const AUTOCUT_SYSTEM = `You are an auto-edit assistant. Given a list of spoken words with timings, remove filler words ("um","uh","like","you know","actually"...), repetitions, and off-topic segments according to the options.
Return ONLY a JSON array of word indices to KEEP, nothing else, e.g. [0,1,4,5]. No commentary.`;

export async function captionAi({ kind, words = [], src = "", tgt = "en", spanMs = 3000, options = {} }) {
  const text = words.map((w) => (typeof w === "string" ? w : w.word)).join(" ");
  if (kind === "roman") {
    // Per-word transliteration preserves the word-level timestamps.
    const list = words.map((w, i) => `${i}: ${typeof w === "string" ? w : w.word}`).join("\n");
    const raw = await chat(ROMAN_WORDS_SYSTEM, list, { temperature: 0, maxTokens: 4096 });
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      const arr = match ? JSON.parse(match[0]) : null;
      if (Array.isArray(arr) && arr.length === words.length) return { words: arr.map((x) => String(x).trim()) };
    } catch {}
    return { words: null, raw: raw.slice(0, 500) };
  }
  if (kind === "translate") {
    return { text: await chat(TRANSLATE_SYSTEM, `Translate to "${tgt}":\n${text}`) };
  }
  if (kind === "auto-edit") {
    const optionsText = JSON.stringify(options ?? {});
    const raw = await chat(
      AUTOCUT_SYSTEM,
      `Options: ${optionsText}\nWords:\n${text}`,
      { temperature: 0, maxTokens: 4096 }
    );
    try {
      const match = raw.match(/\[[\d,\s]*\]/);
      const indices = match ? JSON.parse(match[0]) : [];
      return { keepIndices: indices };
    } catch {
      return { keepIndices: null, raw };
    }
  }
  throw new Error(`Unknown caption-ai kind: ${kind}`);
}
