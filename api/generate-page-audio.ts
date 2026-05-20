import type { VercelRequest, VercelResponse } from "@vercel/node";

// Allow up to 60s for TTS generation + Whisper alignment
export const config = { maxDuration: 60 };

// Rate limit: max 8 requests per minute per API key
const RATE_LIMIT_TOKENS = 8;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

function tryConsume(bucketKey: string): boolean {
  const now = Date.now();
  let bucket = buckets.get(bucketKey);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_TOKENS, lastRefill: now };
    buckets.set(bucketKey, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor((elapsed / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_TOKENS);
  if (refill > 0) {
    bucket.tokens = Math.min(RATE_LIMIT_TOKENS, bucket.tokens + refill);
    bucket.lastRefill = now;
  }
  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }
  return false;
}

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    lastRes = res;
    const retryAfter = res.headers.get("retry-after");
    let waitMs: number;
    if (retryAfter && !isNaN(Number(retryAfter))) {
      waitMs = Math.min(Number(retryAfter) * 1000, 15_000);
    } else {
      waitMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  return lastRes!;
}

function norm(w: string) { return w.toLowerCase().replace(/[^a-z0-9']/g, ""); }

function mapTimingsToOriginal(
  originalWords: string[],
  whisperWords: { word: string; start: number; end: number }[]
): { start: number; end: number }[] {
  if (whisperWords.length === 0 || originalWords.length === 0) return [];
  const totalDuration = whisperWords[whisperWords.length - 1].end;

  if (whisperWords.length === originalWords.length) {
    return whisperWords.map(w => ({ start: w.start, end: w.end }));
  }

  const result: { start: number; end: number }[] = [];
  let wi = 0;

  for (let oi = 0; oi < originalWords.length; oi++) {
    const origNorm = norm(originalWords[oi]);
    if (wi < whisperWords.length) {
      const whisperNorm = norm(whisperWords[wi].word);
      if (origNorm === whisperNorm || origNorm.startsWith(whisperNorm) || whisperNorm.startsWith(origNorm)) {
        result.push({ start: whisperWords[wi].start, end: whisperWords[wi].end });
        wi++;
      } else {
        const prevEnd = wi > 0 ? whisperWords[wi - 1].end : 0;
        const nextStart = whisperWords[wi].start;
        result.push({ start: prevEnd, end: nextStart });
      }
    } else {
      const lastEnd = whisperWords.length > 0 ? whisperWords[whisperWords.length - 1].end : 0;
      const remaining = originalWords.length - oi;
      const perWord = (totalDuration - lastEnd) / remaining;
      const s = lastEnd + (oi - (originalWords.length - remaining)) * perWord;
      result.push({ start: s, end: s + perWord });
    }
  }

  return result;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const {
      bookId,
      pageNumber,
      text,
      voice = "daniel",
      apiKey,
      userId,
    } = req.body;

    if (!bookId || !pageNumber || !text || !userId) {
      res.status(400).json({ error: "bookId, pageNumber, text, userId required" });
      return;
    }

    const groqKey = apiKey || process.env.GROQ_TTS;
    const groqBaseUrl = process.env.GROQ_BASEURL || "https://api.groq.com/openai/v1/audio/speech";

    if (!groqKey) {
      res.status(401).json({ error: "No TTS API key configured." });
      return;
    }

    const bucketKey = `groq-page:${groqKey.slice(-8)}`;
    if (!tryConsume(bucketKey)) {
      res.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }

    const input = text.slice(0, 4096);

    // Generate TTS audio
    const ttsRes = await fetchWithRetry(groqBaseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "canopylabs/orpheus-v1-english",
        input,
        voice,
        response_format: "wav",
      }),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      res.status(503).json({ error: `Groq TTS failed (${ttsRes.status}): ${errText}` });
      return;
    }

    const audioBuf = Buffer.from(await ttsRes.arrayBuffer());

    // Get word timings via Whisper (non-fatal)
    let wordTimings: { word: string; start: number; end: number }[] = [];
    if (tryConsume(bucketKey)) {
      try {
        const form = new FormData();
        form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "page.wav");
        form.append("model", "whisper-large-v3-turbo");
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "word");
        form.append("language", "en");

        const whisperUrl = groqBaseUrl.replace("audio/speech", "audio/transcriptions");
        const whisperRes = await fetchWithRetry(whisperUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${groqKey}` },
          body: form,
        }, 1);

        if (whisperRes.ok) {
          const whisperData = await whisperRes.json();
          if (whisperData.words && Array.isArray(whisperData.words)) {
            wordTimings = whisperData.words.map((w: any) => ({
              word: w.word, start: w.start, end: w.end,
            }));
          }
        }
      } catch (e) {
        console.warn("Whisper alignment failed (non-fatal):", e);
      }
    }

    // Map timings to original words
    const originalWords = text.split(/\s+/).filter(Boolean);
    const mappedTimings = mapTimingsToOriginal(originalWords, wordTimings);
    const duration = wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : null;

    // Return audio + timings — browser handles storage upload
    res.setHeader("Content-Type", "application/json");
    res.json({
      audio: audioBuf.toString("base64"),
      duration,
      timings: mappedTimings,
      provider: "groq",
    });
  } catch (e: any) {
    console.error("generate-page-audio error:", e);
    res.status(500).json({ error: e.message || "Internal error" });
  }
}
