import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Groq Orpheus TTS voices mapped to book genres/moods
const VOICE_PRESETS: Record<string, { voice: string; direction: string }> = {
  narrator:            { voice: "daniel", direction: "[warm]" },
  warm_male:           { voice: "troy",   direction: "[friendly]" },
  deep_male:           { voice: "austin", direction: "[authoritatively]" },
  young_male:          { voice: "austin", direction: "[cheerful]" },
  warm_female:         { voice: "autumn", direction: "[warm]" },
  storyteller_female:  { voice: "hannah", direction: "[dramatic]" },
  young_female:        { voice: "diana",  direction: "[cheerful]" },
};

const CHUNK_WORDS = 30; // ~200 char limit on Groq Orpheus

function chunkWords(words: string[], pageNumber: number, startIndex: number) {
  const chunks: { page: number; start: number; end: number; text: string }[] = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS) {
    const slice = words.slice(i, i + CHUNK_WORDS);
    const text = slice.join(" ");
    // Groq Orpheus has 200 char limit; if text is too long, split further
    if (text.length > 195) {
      const mid = Math.floor(slice.length / 2);
      const a = slice.slice(0, mid);
      const b = slice.slice(mid);
      chunks.push({ page: pageNumber, start: startIndex + i, end: startIndex + i + a.length - 1, text: a.join(" ") });
      chunks.push({ page: pageNumber, start: startIndex + i + a.length, end: startIndex + i + slice.length - 1, text: b.join(" ") });
    } else {
      chunks.push({ page: pageNumber, start: startIndex + i, end: startIndex + i + slice.length - 1, text });
    }
  }
  return chunks;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured");

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userRes } = await userClient.auth.getUser();
    const user = userRes?.user;
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json();
    const { bookId, pages, voicePreset, maxPages } = body as {
      bookId: string;
      pages: { page: number; words: string[] }[];
      voicePreset: string;
      maxPages?: number;
    };

    const preset = VOICE_PRESETS[voicePreset] || VOICE_PRESETS.narrator;

    // Update book status
    await admin.from("books").update({ tts_status: "generating", tts_progress: 0, voice_id: preset.voice, voice_description: voicePreset }).eq("id", bookId);

    // Build chunks
    const limit = Math.min(pages.length, maxPages ?? 5);
    const allChunks: { page: number; start: number; end: number; text: string }[] = [];
    let runningWordOffset = 0;
    for (let p = 0; p < limit; p++) {
      const pg = pages[p];
      allChunks.push(...chunkWords(pg.words, pg.page, runningWordOffset));
      runningWordOffset += pg.words.length;
    }

    // Get existing chunk count to continue from
    const { data: existingChunks } = await admin.from("audio_chunks").select("chunk_index").eq("book_id", bookId).order("chunk_index", { ascending: false }).limit(1);
    let chunkIdx = existingChunks?.length ? existingChunks[0].chunk_index + 1 : 0;

    for (const c of allChunks) {
      try {
        // Prepend vocal direction to text
        const inputText = `${preset.direction} ${c.text}`.slice(0, 200);

        const ttsResp = await fetch("https://api.groq.com/openai/v1/audio/speech", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "canopylabs/orpheus-v1-english",
            input: inputText,
            voice: preset.voice,
            response_format: "wav",
          }),
        });

        if (!ttsResp.ok) {
          const t = await ttsResp.text();
          console.error("TTS fail", ttsResp.status, t);
          if (ttsResp.status === 429 || ttsResp.status === 401) {
            await admin.from("books").update({ tts_status: "error" }).eq("id", bookId);
            return new Response(JSON.stringify({ error: t }), { status: ttsResp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
          continue;
        }

        const audioBuf = new Uint8Array(await ttsResp.arrayBuffer());
        const path = `${user.id}/${bookId}/chunk_${chunkIdx}.wav`;
        const { error: upErr } = await admin.storage.from("audio").upload(path, audioBuf, {
          contentType: "audio/wav",
          upsert: true,
        });
        if (upErr) { console.error("upload err", upErr); continue; }

        const wordCount = c.end - c.start + 1;
        // Estimate ~0.38s per word; will be refined by client-side audio duration
        const estDur = wordCount * 0.38;
        const wordTimings = Array.from({ length: wordCount }, (_, i) => ({
          word: i,
          start: (i * estDur) / wordCount,
          end: ((i + 1) * estDur) / wordCount,
        }));

        await admin.from("audio_chunks").insert({
          book_id: bookId,
          user_id: user.id,
          chunk_index: chunkIdx,
          page_number: c.page,
          start_word_index: c.start,
          end_word_index: c.end,
          text_content: c.text,
          audio_path: path,
          duration_seconds: estDur,
          word_timings: wordTimings,
          status: "ready",
        });

        chunkIdx++;
        const progress = Math.round((chunkIdx / allChunks.length) * 100);
        await admin.from("books").update({ tts_progress: Math.min(progress, 99) }).eq("id", bookId);
      } catch (e) {
        console.error("chunk err", e);
      }
    }

    await admin.from("books").update({ tts_status: "ready", tts_progress: 100 }).eq("id", bookId);

    return new Response(JSON.stringify({ success: true, chunks: chunkIdx }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
