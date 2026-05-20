import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import type { Plugin } from "vite";

/**
 * Normalize a word for comparison (strip punctuation, lowercase).
 */
function norm(w: string) { return w.toLowerCase().replace(/[^a-z0-9']/g, ""); }

/**
 * Map Whisper word timings back to the original text words.
 * Handles count mismatches from punctuation, contractions, etc.
 */
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
    const origN = norm(originalWords[oi]);
    if (wi < whisperWords.length) {
      const whisperN = norm(whisperWords[wi].word);
      if (origN === whisperN || origN.startsWith(whisperN) || whisperN.startsWith(origN)) {
        result.push({ start: whisperWords[wi].start, end: whisperWords[wi].end });
        wi++;
      } else {
        const prevEnd = wi > 0 ? whisperWords[wi - 1].end : 0;
        const nextStart = whisperWords[wi].start;
        result.push({ start: prevEnd, end: nextStart });
      }
    } else {
      const lastEnd = whisperWords[whisperWords.length - 1]?.end || 0;
      const remaining = originalWords.length - oi;
      const perWord = Math.max(0.1, (totalDuration - lastEnd) / remaining);
      const s = lastEnd + (result.length - (originalWords.length - remaining)) * perWord;
      result.push({ start: s, end: s + perWord });
    }
  }
  return result;
}

/**
 * Dev-only Vite plugin: proxy /api/tts to Groq Orpheus TTS + Whisper alignment.
 * Returns JSON with base64 audio + precise word-level timestamps.
 */
function groqTtsProxy(): Plugin {
  return {
    name: "groq-tts-proxy",
    configureServer(server) {
      server.middlewares.use("/api/tts", async (req, res, next) => {
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type");
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method !== "POST") { next(); return; }

        // Read request body
        const bodyChunks: Buffer[] = [];
        for await (const chunk of req) bodyChunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());

        // Each user provides their own key — no shared server key
        const key = body.apiKey;
        if (!key) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No API key provided. Add your Groq API key in Settings." }));
          return;
        }

        const { text, voice = "daniel" } = body;
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "text is required" }));
          return;
        }

        try {
          const input = text.slice(0, 4096);

          // Step 1: Generate TTS audio
          const groqBaseUrl = "https://api.groq.com/openai/v1/audio/speech";
          const ttsRes = await fetch(groqBaseUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "canopylabs/orpheus-v1-english",
              input,
              voice,
              response_format: "wav",
            }),
          });

          if (!ttsRes.ok) {
            const t = await ttsRes.text();
            res.writeHead(ttsRes.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: t }));
            return;
          }

          const audioBuf = Buffer.from(await ttsRes.arrayBuffer());

          // Step 2: Get word-level timestamps via Whisper
          let wordTimings: { word: string; start: number; end: number }[] = [];
          try {
            const form = new FormData();
            form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "chunk.wav");
            form.append("model", "whisper-large-v3-turbo");
            form.append("response_format", "verbose_json");
            form.append("timestamp_granularities[]", "word");
            form.append("language", "en");

            const whisperUrl = groqBaseUrl.replace("audio/speech", "audio/transcriptions");
            const whisperRes = await fetch(whisperUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}` },
              body: form,
            });

            if (whisperRes.ok) {
              const whisperData = await whisperRes.json();
              if (whisperData.words && Array.isArray(whisperData.words)) {
                wordTimings = whisperData.words.map((w: any) => ({
                  word: w.word,
                  start: w.start,
                  end: w.end,
                }));
              }
            }
          } catch (e) {
            console.warn("Whisper alignment failed:", e);
          }

          // Step 3: Map timings to original words
          const originalWords = text.split(/\s+/).filter(Boolean);
          const mappedTimings = mapTimingsToOriginal(originalWords, wordTimings);

          // Return JSON with base64 audio + word timings
          const json = JSON.stringify({
            audio: audioBuf.toString("base64"),
            duration: wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : null,
            timings: mappedTimings,
            provider: "groq",
          });

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(json).toString(),
            "Cache-Control": "public, max-age=3600",
          });
          res.end(json);
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

/**
 * Dev-only Vite plugin: proxy /api/generate-page-audio to Groq TTS + Whisper.
 * Used by the background audio pre-generation service.
 */
function groqPageAudioProxy(): Plugin {
  return {
    name: "groq-page-audio-proxy",
    configureServer(server) {
      server.middlewares.use("/api/generate-page-audio", async (req, res, next) => {
        if (req.method === "OPTIONS") {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method !== "POST") { next(); return; }

        const bodyChunks: Buffer[] = [];
        for await (const chunk of req) bodyChunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(bodyChunks).toString());

        const { bookId, pageNumber, text, voice = "daniel", apiKey, userId } = body;

        if (!bookId || !pageNumber || !text || !userId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bookId, pageNumber, text, userId required" }));
          return;
        }

        // Each user provides their own key — no shared server key
        const key = apiKey;
        if (!key) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No API key provided. Add your Groq API key in Settings." }));
          return;
        }

        try {
          const input = text.slice(0, 4096);
          const groqBaseUrl = "https://api.groq.com/openai/v1/audio/speech";

          // Generate TTS
          const ttsRes = await fetch(groqBaseUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "canopylabs/orpheus-v1-english",
              input,
              voice,
              response_format: "wav",
            }),
          });

          if (!ttsRes.ok) {
            const t = await ttsRes.text();
            res.writeHead(ttsRes.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: t }));
            return;
          }

          const audioBuf = Buffer.from(await ttsRes.arrayBuffer());

          // Get word timings via Whisper (non-fatal)
          let wordTimings: { word: string; start: number; end: number }[] = [];
          try {
            const form = new FormData();
            form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "page.wav");
            form.append("model", "whisper-large-v3-turbo");
            form.append("response_format", "verbose_json");
            form.append("timestamp_granularities[]", "word");
            form.append("language", "en");

            const whisperUrl = groqBaseUrl.replace("audio/speech", "audio/transcriptions");
            const whisperRes = await fetch(whisperUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${key}` },
              body: form,
            });

            if (whisperRes.ok) {
              const whisperData = await whisperRes.json();
              if (whisperData.words && Array.isArray(whisperData.words)) {
                wordTimings = whisperData.words.map((w: any) => ({
                  word: w.word, start: w.start, end: w.end,
                }));
              }
            }
          } catch (e) {
            console.warn("Whisper alignment failed:", e);
          }

          const originalWords = text.split(/\s+/).filter(Boolean);
          const mappedTimings = mapTimingsToOriginal(originalWords, wordTimings);
          const duration = wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : null;

          // Return audio + timings — browser handles storage upload
          const json = JSON.stringify({
            audio: audioBuf.toString("base64"),
            duration,
            timings: mappedTimings,
            provider: "groq",
          });

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(json).toString(),
          });
          res.end(json);
        } catch (e: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: { overlay: false },
    },
    plugins: [
      react(),
      mode === "development" && componentTagger(),
      mode === "development" && groqTtsProxy(),
      mode === "development" && groqPageAudioProxy(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
    },
  };
});
