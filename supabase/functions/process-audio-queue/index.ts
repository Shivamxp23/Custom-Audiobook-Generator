import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech";
const GROQ_WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const BATCH_SIZE = 8; // pages per invocation (stay within 150s wall time)
const INTER_REQUEST_DELAY_MS = 4000; // rate limit safety

/**
 * Supabase Edge Function: process-audio-queue
 *
 * Picks pending pages from page_audio_cache, generates TTS audio via Groq,
 * uploads the WAV to Supabase Storage, and marks pages as ready.
 *
 * Self-chains: after processing a batch, if more pages remain it invokes
 * itself again so generation continues even if the user's browser is closed.
 *
 * Input JSON body: { bookId: string, priorityPage?: number }
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  // Admin client for DB operations (bypasses RLS)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // Authenticate the calling user (or accept service-role self-chain)
    const authHeader = req.headers.get("Authorization") || "";
    let userId: string | null = null;

    // Try user auth first
    if (authHeader.startsWith("Bearer ")) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userRes } = await userClient.auth.getUser();
      userId = userRes?.user?.id || null;
    }

    const body = await req.json().catch(() => ({}));
    const { bookId, priorityPage, selfChain, chainUserId } = body as {
      bookId?: string;
      priorityPage?: number;
      selfChain?: boolean;
      chainUserId?: string;
    };

    // For self-chained calls, use the stored userId
    if (selfChain && chainUserId) {
      userId = chainUserId;
    }

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // If a priorityPage is specified, bump its priority
    if (bookId && priorityPage) {
      await admin
        .from("page_audio_cache")
        .update({ priority: 9999, status: "pending" })
        .eq("book_id", bookId)
        .eq("page_number", priorityPage)
        .neq("status", "ready");
    }

    // Get the user's Groq API key from their profile
    const { data: profile } = await admin
      .from("profiles")
      .select("groq_api_key")
      .eq("user_id", userId)
      .single();

    const groqKey = profile?.groq_api_key;
    if (!groqKey) {
      // Mark all pending pages as error
      if (bookId) {
        await admin
          .from("page_audio_cache")
          .update({ status: "error" })
          .eq("book_id", bookId)
          .eq("user_id", userId)
          .in("status", ["pending", "generating"]);

        await admin
          .from("books")
          .update({ tts_status: "error" })
          .eq("id", bookId);
      }
      return new Response(
        JSON.stringify({ error: "No Groq API key found in profile. Add it in Settings." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Pick next batch of pending pages
    let query = admin
      .from("page_audio_cache")
      .select("id, book_id, page_number, voice")
      .eq("user_id", userId)
      .in("status", ["pending", "generating"])
      .order("priority", { ascending: false })
      .order("page_number", { ascending: true })
      .limit(BATCH_SIZE);

    if (bookId) {
      query = query.eq("book_id", bookId);
    }

    const { data: pendingPages, error: qErr } = await query;
    if (qErr) {
      console.error("Query error:", qErr.message);
      return new Response(
        JSON.stringify({ error: qErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!pendingPages || pendingPages.length === 0) {
      // All done — update book status
      if (bookId) {
        await admin
          .from("books")
          .update({ tts_status: "ready", tts_progress: 100 })
          .eq("id", bookId);
      }
      return new Response(
        JSON.stringify({ success: true, message: "No pending pages", processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let processed = 0;
    let errors = 0;
    const resolvedBookId = bookId || pendingPages[0].book_id;

    for (const page of pendingPages) {
      try {
        // Mark as generating
        await admin
          .from("page_audio_cache")
          .update({ status: "generating" })
          .eq("id", page.id);

        // Get page text from book_pages
        const { data: pageData } = await admin
          .from("book_pages")
          .select("text")
          .eq("book_id", page.book_id)
          .eq("page_number", page.page_number)
          .single();

        if (!pageData?.text?.trim()) {
          // Empty page — mark as ready with no audio
          await admin
            .from("page_audio_cache")
            .update({ status: "ready", audio_storage_path: "" })
            .eq("id", page.id);
          processed++;
          continue;
        }

        const inputText = pageData.text.slice(0, 4096);

        // ── Generate TTS audio ──
        const ttsRes = await fetch(GROQ_TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "canopylabs/orpheus-v1-english",
            input: inputText,
            voice: page.voice || "daniel",
            response_format: "wav",
          }),
        });

        if (!ttsRes.ok) {
          const errText = await ttsRes.text();
          console.error(`TTS failed for page ${page.page_number} (${ttsRes.status}):`, errText);

          if (ttsRes.status === 401) {
            // Invalid API key — stop everything
            await admin
              .from("page_audio_cache")
              .update({ status: "error" })
              .eq("book_id", page.book_id)
              .eq("user_id", userId)
              .in("status", ["pending", "generating"]);
            await admin
              .from("books")
              .update({ tts_status: "error" })
              .eq("id", page.book_id);
            return new Response(
              JSON.stringify({ error: "Invalid API key", processed }),
              { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          if (ttsRes.status === 429) {
            // Rate limited — put page back and wait
            await admin
              .from("page_audio_cache")
              .update({ status: "pending" })
              .eq("id", page.id);
            await delay(15000);
            continue;
          }

          // Other error — mark page and continue
          await admin
            .from("page_audio_cache")
            .update({ status: "error" })
            .eq("id", page.id);
          errors++;
          continue;
        }

        const audioBuf = new Uint8Array(await ttsRes.arrayBuffer());

        // ── Get word timings via Whisper (non-fatal) ──
        let wordTimings: { word: string; start: number; end: number }[] = [];
        try {
          await delay(INTER_REQUEST_DELAY_MS);

          const form = new FormData();
          form.append("file", new Blob([audioBuf], { type: "audio/wav" }), "page.wav");
          form.append("model", "whisper-large-v3-turbo");
          form.append("response_format", "verbose_json");
          form.append("timestamp_granularities[]", "word");
          form.append("language", "en");

          const whisperRes = await fetch(GROQ_WHISPER_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${groqKey}` },
            body: form,
          });

          if (whisperRes.ok) {
            const whisperData = await whisperRes.json();
            if (whisperData.words && Array.isArray(whisperData.words)) {
              wordTimings = whisperData.words.map((w: { word: string; start: number; end: number }) => ({
                word: w.word,
                start: w.start,
                end: w.end,
              }));
            }
          }
        } catch (e) {
          console.warn("Whisper failed (non-fatal):", e);
        }

        // Map timings to original words
        const originalWords = pageData.text.split(/\s+/).filter(Boolean);
        const mappedTimings = mapTimingsToOriginal(originalWords, wordTimings);
        const duration = wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].end : null;

        // ── Upload WAV to Supabase Storage ──
        const storagePath = `${userId}/audio/${page.book_id}/page_${page.page_number}.wav`;
        const { error: uploadErr } = await admin.storage
          .from("books")
          .upload(storagePath, audioBuf, {
            contentType: "audio/wav",
            upsert: true,
          });

        if (uploadErr) {
          console.error(`Storage upload failed page ${page.page_number}:`, uploadErr.message);
          await admin
            .from("page_audio_cache")
            .update({ status: "error" })
            .eq("id", page.id);
          errors++;
          continue;
        }

        // ── Update cache entry as ready ──
        await admin
          .from("page_audio_cache")
          .update({
            status: "ready",
            audio_storage_path: storagePath,
            duration_seconds: duration,
            word_timings: mappedTimings,
          })
          .eq("id", page.id);

        processed++;
        console.log(`[ProcessQueue] Page ${page.page_number} DONE (${storagePath})`);

        // Update book progress
        const { count: totalCount } = await admin
          .from("page_audio_cache")
          .select("*", { count: "exact", head: true })
          .eq("book_id", page.book_id);
        const { count: readyCount } = await admin
          .from("page_audio_cache")
          .select("*", { count: "exact", head: true })
          .eq("book_id", page.book_id)
          .eq("status", "ready");

        if (totalCount && readyCount) {
          const progress = Math.round((readyCount / totalCount) * 100);
          await admin
            .from("books")
            .update({
              tts_progress: Math.min(progress, 99),
              tts_status: "generating",
            })
            .eq("id", page.book_id);
        }

        // Rate limit delay before next page
        await delay(INTER_REQUEST_DELAY_MS);
      } catch (e) {
        console.error(`Error processing page ${page.page_number}:`, e);
        await admin
          .from("page_audio_cache")
          .update({ status: "error" })
          .eq("id", page.id);
        errors++;
      }
    }

    // ── Self-chain: check if more pending pages remain ──
    const { count: remainingCount } = await admin
      .from("page_audio_cache")
      .select("*", { count: "exact", head: true })
      .eq("book_id", resolvedBookId)
      .eq("user_id", userId)
      .in("status", ["pending"]);

    if (remainingCount && remainingCount > 0) {
      console.log(`[ProcessQueue] ${remainingCount} pages remaining — self-chaining...`);
      // Fire-and-forget self-invocation
      const selfUrl = `${SUPABASE_URL}/functions/v1/process-audio-queue`;
      fetch(selfUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bookId: resolvedBookId,
          selfChain: true,
          chainUserId: userId,
        }),
      }).catch((e) => console.error("Self-chain failed:", e));
    } else {
      // All done
      await admin
        .from("books")
        .update({ tts_status: "ready", tts_progress: 100 })
        .eq("id", resolvedBookId);
      console.log("[ProcessQueue] All pages complete!");
    }

    return new Response(
      JSON.stringify({ success: true, processed, errors, remaining: remainingCount || 0 }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Edge function error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── Helpers ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(w: string) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, "");
}

function mapTimingsToOriginal(
  originalWords: string[],
  whisperWords: { word: string; start: number; end: number }[]
): { start: number; end: number }[] {
  if (whisperWords.length === 0 || originalWords.length === 0) return [];
  const totalDuration = whisperWords[whisperWords.length - 1].end;

  if (whisperWords.length === originalWords.length) {
    return whisperWords.map((w) => ({ start: w.start, end: w.end }));
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
      const s = lastEnd + (oi - (originalWords.length - remaining)) * perWord;
      result.push({ start: s, end: s + perWord });
    }
  }
  return result;
}
