import type { VercelRequest, VercelResponse } from "@vercel/node";

// ── In-memory per-key rate limiter (token bucket) ──────────────────────
// Groq free tier rate limits
const RATE_LIMIT_TOKENS = 12;
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

  // Refill tokens based on elapsed time
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

// ── Retry with exponential backoff ─────────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 2
): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    lastRes = res;

    // Parse Retry-After header if present (seconds), otherwise exponential backoff
    const retryAfter = res.headers.get("retry-after");
    let waitMs: number;
    if (retryAfter && !isNaN(Number(retryAfter))) {
      waitMs = Math.min(Number(retryAfter) * 1000, 15_000);
    } else {
      waitMs = Math.min(1000 * Math.pow(2, attempt), 10_000);
    }

    if (attempt < maxRetries) {
      console.warn(`Rate limited (429), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  return lastRes!;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const {
      text,
      voice = "daniel",
      apiKey,
    } = req.body;

    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "text required" });
      return;
    }

    const groqKey = apiKey || process.env.GROQ_TTS;
    const groqBaseUrl = process.env.GROQ_BASEURL || "https://api.groq.com/openai/v1/audio/speech";

    if (!groqKey) {
      res.status(401).json({
        error: "No TTS API key configured. Check GROQ_TTS in .env or provide your personal key.",
        fallbackToBrowser: true,
      });
      return;
    }

    const bucketKey = `groq:${groqKey.slice(-8)}`;
    if (!tryConsume(bucketKey)) {
      res.status(429).json({ error: "Groq rate limit exceeded. Please try again later." });
      return;
    }

    const input = text.slice(0, 4096);
    
    // Using canopylabs/orpheus-v1-english model
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
      res.status(503).json({
        error: `Groq TTS failed (${ttsRes.status}): ${errText}`,
        fallbackToBrowser: true,
      });
      return;
    }

    const audioBuf = Buffer.from(await ttsRes.arrayBuffer());
    let wordTimings: { word: string; start: number; end: number }[] = [];

    // Get word-level timestamps via Whisper (non-fatal if errors)
    if (tryConsume(bucketKey)) {
      try {
        const form = new FormData();
        form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "chunk.wav");
        form.append("model", "whisper-large-v3-turbo");
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "word");
        form.append("language", "en");

        // The transcriptions endpoint uses the base groq api, so we'll just construct it
        // Or if GROQ_BASEURL is specific to audio/speech, we can modify it
        const whisperUrl = groqBaseUrl.replace("audio/speech", "audio/transcriptions");

        const whisperRes = await fetchWithRetry(
          whisperUrl,
          { method: "POST", headers: { Authorization: `Bearer ${groqKey}` }, body: form },
          1 // fewer retries for whisper — it's optional
        );

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
    } else {
      console.warn("Skipping Whisper — rate limit budget exhausted");
    }

    // ── Map timings to original words ──
    const originalWords = text.split(/\s+/).filter(Boolean);
    const mappedTimings = mapTimingsToOriginal(originalWords, wordTimings);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json({
      audio: audioBuf.toString("base64"),
      duration: wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : null,
      timings: mappedTimings,
      provider: "groq",
    });
  } catch (e: any) {
    console.error("TTS handler error:", e);
    res.status(500).json({ error: e.message || "Internal error", fallbackToBrowser: true });
  }
}

// ── Map Whisper word timings back to original text words ────
function mapTimingsToOriginal(
  originalWords: string[],
  whisperWords: { word: string; start: number; end: number }[]
): { start: number; end: number }[] {
  if (whisperWords.length === 0 || originalWords.length === 0) return [];

  const totalDuration = whisperWords[whisperWords.length - 1].end;
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");

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
