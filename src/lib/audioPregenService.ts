/**
 * Audio Pre-generation Service (Client-side orchestrator)
 *
 * On upload or reader open:
 *  1. Saves page texts to book_pages table (if not already there)
 *  2. Creates pending entries in page_audio_cache
 *  3. Invokes the server-side Edge Function (process-audio-queue) which:
 *     - Generates TTS audio via Groq (using user's own API key)
 *     - Uploads WAV to Supabase Storage
 *     - Self-chains until all pages are done
 *  4. Polls page_audio_cache to track progress and notify UI
 *
 * The Edge Function runs server-side — generation continues even
 * if the user closes their browser.
 */

import { supabase } from "@/integrations/supabase/client";

export interface PageInfo {
  page: number;
  text: string;
  words: string[];
}

export interface AudioCacheEntry {
  pageNumber: number;
  status: "pending" | "generating" | "ready" | "error";
  storagePath: string;
  duration: number | null;
  timings: { start: number; end: number }[];
}

type ProgressCallback = (progress: {
  totalPages: number;
  completedPages: number;
  currentPage: number | null;
  status: "idle" | "generating" | "complete" | "error";
}) => void;

const POLL_INTERVAL_MS = 3000;

class AudioPregenService {
  private bookId: string = "";
  private userId: string = "";
  private voice: string = "daniel";
  private pages: PageInfo[] = [];
  private cache: Map<string, AudioCacheEntry> = new Map();
  private progressCallback: ProgressCallback | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isActive: boolean = false;
  private completedCount: number = 0;

  /**
   * Start pre-generation for a book.
   * 1. Saves page text to DB
   * 2. Creates queue entries
   * 3. Triggers the server-side Edge Function
   * 4. Starts polling for progress
   */
  async start(
    bookId: string,
    userId: string,
    pages: PageInfo[],
    voice: string,
    apiKey?: string,
    onProgress?: ProgressCallback
  ) {
    // If already active for this book, just update callback and poll
    if (this.isActive && this.bookId === bookId) {
      this.progressCallback = onProgress || null;
      return;
    }

    // If active for a different book, stop polling
    if (this.isActive) {
      this.stop();
    }

    console.log(`[AudioPregen] Starting for book ${bookId}, ${pages.length} pages`);

    this.bookId = bookId;
    this.userId = userId;
    this.pages = pages;
    this.voice = voice;
    this.progressCallback = onProgress || null;
    this.completedCount = 0;
    this.cache.clear();
    this.isActive = true;

    // Step 1: Load existing cache from DB to see what's already done
    await this.loadExistingCache();

    // Count how many are already ready
    const alreadyReady = Array.from(this.cache.values()).filter(
      (e) => e.status === "ready" && e.storagePath
    ).length;
    this.completedCount = alreadyReady;

    if (alreadyReady >= pages.length) {
      console.log("[AudioPregen] All pages already have audio");
      this.notifyProgress(null, "complete");
      this.isActive = false;
      return;
    }

    // Step 2: Save page texts to book_pages (for server-side access)
    await this.savePageTexts(bookId, pages);

    // Step 3: Create pending entries in page_audio_cache for pages without audio
    await this.createQueueEntries(bookId, userId, pages, voice);

    // Step 4: Trigger the Edge Function
    this.notifyProgress(null, "generating");
    await this.triggerEdgeFunction(bookId);

    // Step 5: Start polling for progress
    this.startPolling();
  }

  /**
   * Prioritize a specific page (user navigated to it).
   * Updates the DB priority and re-triggers the edge function.
   */
  async prioritizePage(pageNumber: number) {
    if (!this.bookId) return;

    const key = `${this.bookId}:${pageNumber}`;
    const cached = this.cache.get(key);
    if (cached?.status === "ready" && cached.storagePath) return;

    console.log(`[AudioPregen] Prioritizing page ${pageNumber}`);

    // Update priority in DB
    await supabase
      .from("page_audio_cache")
      .update({ priority: 9999 })
      .eq("book_id", this.bookId)
      .eq("page_number", pageNumber)
      .neq("status", "ready");

    // Re-trigger edge function with priority
    await this.triggerEdgeFunction(this.bookId, pageNumber);
  }

  /**
   * Check if a page has cached audio ready.
   */
  getCachedAudio(bookId: string, pageNumber: number): AudioCacheEntry | null {
    const key = `${bookId}:${pageNumber}`;
    const entry = this.cache.get(key);
    if (entry && entry.status === "ready" && entry.storagePath) {
      return entry;
    }
    return null;
  }

  /**
   * Download audio from Supabase Storage.
   */
  async downloadPageAudio(storagePath: string): Promise<string | null> {
    try {
      const { data, error } = await supabase.storage
        .from("books")
        .download(storagePath);

      if (error || !data) {
        console.warn("[AudioPregen] Storage download failed:", error?.message);
        return null;
      }

      const url = URL.createObjectURL(data);
      return url;
    } catch (e) {
      console.warn("[AudioPregen] Download error:", e);
      return null;
    }
  }

  isPageReady(bookId: string, pageNumber: number): boolean {
    const key = `${bookId}:${pageNumber}`;
    const entry = this.cache.get(key);
    return entry?.status === "ready" && !!entry.storagePath;
  }

  getStatus() {
    return {
      isRunning: this.isActive,
      totalPages: this.pages.length,
      completedPages: this.completedCount,
      remainingPages: this.pages.length - this.completedCount,
    };
  }

  stop() {
    this.isActive = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Internal methods ──────────────────────────────────────────

  private async savePageTexts(bookId: string, pages: PageInfo[]) {
    try {
      // Check if texts are already saved
      const { count } = await supabase
        .from("book_pages")
        .select("*", { count: "exact", head: true })
        .eq("book_id", bookId);

      if (count && count >= pages.length) {
        console.log("[AudioPregen] Page texts already saved");
        return;
      }

      // Batch insert page texts (upsert to handle re-runs)
      const rows = pages.map((p) => ({
        book_id: bookId,
        page_number: p.page,
        text: p.text,
        word_count: p.words.length,
      }));

      // Insert in batches of 50 to avoid payload limits
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase.from("book_pages").upsert(batch, {
          onConflict: "book_id,page_number",
        });
        if (error) {
          console.warn("[AudioPregen] Failed to save page texts:", error.message);
        }
      }

      console.log(`[AudioPregen] Saved ${pages.length} page texts to DB`);
    } catch (e) {
      console.warn("[AudioPregen] Error saving page texts:", e);
    }
  }

  private async createQueueEntries(
    bookId: string,
    userId: string,
    pages: PageInfo[],
    voice: string
  ) {
    try {
      // Get existing entries
      const { data: existing } = await supabase
        .from("page_audio_cache")
        .select("page_number, status")
        .eq("book_id", bookId)
        .eq("voice", voice);

      const existingMap = new Map(
        (existing || []).map((e) => [e.page_number, e.status])
      );

      // Create entries for pages that don't have one yet
      const newEntries = pages
        .filter((p) => !existingMap.has(p.page))
        .map((p) => ({
          book_id: bookId,
          user_id: userId,
          page_number: p.page,
          voice,
          status: "pending" as const,
          audio_storage_path: "",
          priority: 0,
        }));

      if (newEntries.length === 0) {
        console.log("[AudioPregen] All queue entries already exist");
        return;
      }

      // Insert in batches
      for (let i = 0; i < newEntries.length; i += 50) {
        const batch = newEntries.slice(i, i + 50);
        const { error } = await supabase.from("page_audio_cache").insert(batch);
        if (error) {
          console.warn("[AudioPregen] Failed to create queue entries:", error.message);
        }
      }

      console.log(`[AudioPregen] Created ${newEntries.length} queue entries`);
    } catch (e) {
      console.warn("[AudioPregen] Error creating queue entries:", e);
    }
  }

  private async triggerEdgeFunction(bookId: string, priorityPage?: number) {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        console.warn("[AudioPregen] No session — cannot trigger edge function");
        return;
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const url = `${supabaseUrl}/functions/v1/process-audio-queue`;

      const body: Record<string, unknown> = { bookId };
      if (priorityPage) body.priorityPage = priorityPage;

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: "Unknown" }));
        console.warn("[AudioPregen] Edge function error:", errData.error);
        if (resp.status === 401) {
          this.notifyProgress(null, "error");
        }
      } else {
        console.log("[AudioPregen] Edge function triggered successfully");
      }
    } catch (e) {
      console.warn("[AudioPregen] Failed to trigger edge function:", e);
    }
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(async () => {
      if (!this.isActive || !this.bookId) {
        if (this.pollTimer) clearInterval(this.pollTimer);
        return;
      }

      await this.refreshCacheFromDB();

      const readyCount = Array.from(this.cache.values()).filter(
        (e) => e.status === "ready" && e.storagePath
      ).length;
      const errorCount = Array.from(this.cache.values()).filter(
        (e) => e.status === "error"
      ).length;

      this.completedCount = readyCount;

      if (readyCount >= this.pages.length) {
        this.notifyProgress(null, "complete");
        this.stop();
      } else if (errorCount > 0 && readyCount + errorCount >= this.pages.length) {
        // All pages processed but some had errors
        this.notifyProgress(null, "error");
        this.stop();
      } else {
        this.notifyProgress(null, "generating");
      }
    }, POLL_INTERVAL_MS);
  }

  private async refreshCacheFromDB() {
    try {
      const { data } = await supabase
        .from("page_audio_cache")
        .select(
          "page_number, status, audio_storage_path, duration_seconds, word_timings"
        )
        .eq("book_id", this.bookId)
        .eq("voice", this.voice);

      if (data) {
        for (const row of data) {
          const key = `${this.bookId}:${row.page_number}`;
          this.cache.set(key, {
            pageNumber: row.page_number,
            status: row.status as AudioCacheEntry["status"],
            storagePath: row.audio_storage_path || "",
            duration: row.duration_seconds ? Number(row.duration_seconds) : null,
            timings: (row.word_timings as any) || [],
          });
        }
      }
    } catch (e) {
      console.warn("[AudioPregen] Poll error:", e);
    }
  }

  private async loadExistingCache() {
    try {
      const { data } = await supabase
        .from("page_audio_cache")
        .select(
          "page_number, status, audio_storage_path, duration_seconds, word_timings"
        )
        .eq("book_id", this.bookId)
        .eq("voice", this.voice);

      if (data) {
        for (const row of data) {
          const key = `${this.bookId}:${row.page_number}`;
          this.cache.set(key, {
            pageNumber: row.page_number,
            status: row.status as AudioCacheEntry["status"],
            storagePath: row.audio_storage_path || "",
            duration: row.duration_seconds ? Number(row.duration_seconds) : null,
            timings: (row.word_timings as any) || [],
          });
        }
        console.log(`[AudioPregen] Loaded ${data.length} cache entries from DB`);
      }
    } catch (e) {
      console.warn("[AudioPregen] Error loading cache:", e);
    }
  }

  private notifyProgress(
    currentPage: number | null,
    status: "idle" | "generating" | "complete" | "error"
  ) {
    this.progressCallback?.({
      totalPages: this.pages.length,
      completedPages: this.completedCount,
      currentPage,
      status,
    });
  }
}

// Singleton
export const audioPregenService = new AudioPregenService();
