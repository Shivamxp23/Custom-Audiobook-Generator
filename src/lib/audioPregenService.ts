/**
 * Background Audio Pre-generation Service
 * 
 * Generates audio for all pages of a book in the background.
 * Audio WAV files are SAVED to Supabase Storage ("books" bucket).
 * Metadata (path, timings, status) is saved to "page_audio_cache" table.
 * 
 * On playback, audio is downloaded from Supabase Storage — no in-memory base64.
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

// Minimum delay between API calls to respect rate limits
const MIN_REQUEST_INTERVAL_MS = 6000;

class AudioPregenService {
  private bookId: string = "";
  private userId: string = "";
  private voice: string = "daniel";
  private apiKey: string = "";
  private pages: PageInfo[] = [];
  private queue: number[] = [];
  // Lightweight cache: page number → metadata (NO audio blobs in memory)
  private cache: Map<string, AudioCacheEntry> = new Map();
  private isRunning: boolean = false;
  private abortController: AbortController | null = null;
  private progressCallback: ProgressCallback | null = null;
  private lastRequestTime: number = 0;
  private completedCount: number = 0;

  /**
   * Start background generation for a book.
   * Safe to call multiple times for the same book.
   */
  async start(
    bookId: string,
    userId: string,
    pages: PageInfo[],
    voice: string,
    apiKey?: string,
    onProgress?: ProgressCallback
  ) {
    // If already running for THIS book, just update the callback
    if (this.isRunning && this.bookId === bookId) {
      console.log("[AudioPregen] Already running for this book, updating callback");
      this.progressCallback = onProgress || null;
      this.pages = pages;
      this.notifyProgress(null, this.queue.length === 0 ? "complete" : "generating");
      return;
    }

    // If running for a different book, stop first
    if (this.isRunning) {
      this.stop();
    }

    console.log(`[AudioPregen] Starting for book ${bookId}, ${pages.length} pages`);

    this.bookId = bookId;
    this.userId = userId;
    this.pages = pages;
    this.voice = voice;
    this.apiKey = apiKey || "";
    this.progressCallback = onProgress || null;
    this.completedCount = 0;
    this.cache.clear();

    // Load which pages already have audio saved in Supabase
    await this.loadExistingCache();

    // Build queue: only pages that are NOT already ready
    this.queue = [];
    for (let i = 1; i <= pages.length; i++) {
      const key = `${bookId}:${i}`;
      const cached = this.cache.get(key);
      if (cached && cached.status === "ready" && cached.storagePath) {
        this.completedCount++;
      } else {
        this.queue.push(i);
      }
    }

    console.log(`[AudioPregen] ${this.completedCount} already in DB, ${this.queue.length} to generate`);

    if (this.queue.length === 0) {
      this.notifyProgress(null, "complete");
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    this.processQueue();
  }

  /**
   * Prioritize a specific page (move to front of queue)
   */
  prioritizePage(pageNumber: number) {
    const key = `${this.bookId}:${pageNumber}`;
    const cached = this.cache.get(key);
    if (cached?.status === "ready" && cached.storagePath) return;

    this.queue = this.queue.filter(p => p !== pageNumber);
    this.queue.unshift(pageNumber);
    console.log(`[AudioPregen] Prioritized page ${pageNumber}`);
  }

  /**
   * Check if a page has saved audio. Returns the cache entry or null.
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
   * Download a page's audio from Supabase Storage and return an object URL.
   * This is what gets played.
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
      console.log(`[AudioPregen] Downloaded audio from storage: ${storagePath}`);
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
      isRunning: this.isRunning,
      totalPages: this.pages.length,
      completedPages: this.completedCount,
      remainingPages: this.queue.length,
    };
  }

  stop() {
    console.log("[AudioPregen] Stopping");
    this.isRunning = false;
    this.abortController?.abort();
    this.abortController = null;
    this.queue = [];
  }

  // ── Internal methods ──────────────────────────────────────────

  /**
   * Load existing ready entries from Supabase page_audio_cache table.
   */
  private async loadExistingCache() {
    try {
      const { data, error } = await supabase
        .from("page_audio_cache")
        .select("page_number, status, audio_storage_path, duration_seconds, word_timings")
        .eq("book_id", this.bookId)
        .eq("voice", this.voice)
        .eq("status", "ready");

      if (error) {
        console.warn("[AudioPregen] Failed to load cache from DB:", error.message);
        return;
      }

      if (data) {
        for (const row of data) {
          if (row.audio_storage_path) {
            const key = `${this.bookId}:${row.page_number}`;
            this.cache.set(key, {
              pageNumber: row.page_number,
              status: "ready",
              storagePath: row.audio_storage_path,
              duration: row.duration_seconds ? Number(row.duration_seconds) : null,
              timings: (row.word_timings as any) || [],
            });
          }
        }
        console.log(`[AudioPregen] Loaded ${data.length} entries from DB`);
      }
    } catch (e) {
      console.warn("[AudioPregen] Error loading cache:", e);
    }
  }

  /**
   * Process the queue sequentially.
   */
  private async processQueue() {
    console.log(`[AudioPregen] Processing queue: ${this.queue.length} pages`);

    while (this.isRunning && this.queue.length > 0) {
      const pageNumber = this.queue.shift()!;
      const key = `${this.bookId}:${pageNumber}`;

      // Skip if already ready
      const existing = this.cache.get(key);
      if (existing?.status === "ready" && existing.storagePath) {
        this.completedCount++;
        this.notifyProgress(pageNumber, "generating");
        continue;
      }

      // Rate limit
      await this.waitForRateLimit();
      if (!this.isRunning) break;

      console.log(`[AudioPregen] Generating page ${pageNumber}...`);
      const success = await this.generateAndSavePage(pageNumber);

      if (success) {
        this.completedCount++;
        console.log(`[AudioPregen] Page ${pageNumber} SAVED (${this.completedCount}/${this.pages.length})`);
      }

      this.notifyProgress(
        pageNumber,
        this.queue.length === 0 ? "complete" : "generating"
      );
    }

    if (this.isRunning && this.queue.length === 0) {
      this.isRunning = false;
      this.notifyProgress(null, "complete");
      console.log("[AudioPregen] All pages complete!");
    }
  }

  /**
   * Generate audio for a page via TTS API, then:
   *   1. Upload the WAV to Supabase Storage ("books" bucket)
   *   2. Save metadata to "page_audio_cache" table
   */
  private async generateAndSavePage(pageNumber: number): Promise<boolean> {
    const pageData = this.pages[pageNumber - 1];
    if (!pageData || !pageData.text.trim()) return true; // skip empty

    const key = `${this.bookId}:${pageNumber}`;

    try {
      // Use the provided apiKey, or fall back to localStorage
      const effectiveKey = this.apiKey || localStorage.getItem("groq_api_key") || "";

      // ── Step 1: Generate audio via server-side TTS proxy ──
      const resp = await fetch("/api/generate-page-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: this.bookId,
          pageNumber,
          text: pageData.text,
          voice: this.voice,
          apiKey: effectiveKey || undefined,
          userId: this.userId,
        }),
        signal: this.abortController?.signal,
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: "Unknown" }));
        console.warn(`[AudioPregen] TTS API failed for page ${pageNumber} (${resp.status}):`, errData.error);
        
        if (resp.status === 401) {
          // Auth error — no valid API key. Stop the entire queue.
          console.error("[AudioPregen] 401 Unauthorized — no valid API key. Stopping pre-generation.");
          this.isRunning = false;
          this.queue = [];
          this.notifyProgress(pageNumber, "error");
          return false;
        }
        
        if (resp.status === 429) {
          this.queue.unshift(pageNumber);
          await new Promise(r => setTimeout(r, 15_000));
          return false;
        }
        return false;
      }

      const json = await resp.json();
      const audioBase64: string = json.audio;
      const timings = json.timings || [];
      const duration = json.duration || null;

      if (!audioBase64) {
        console.warn(`[AudioPregen] No audio data returned for page ${pageNumber}`);
        return false;
      }

      // ── Step 2: Convert base64 → Blob ──
      const binaryStr = atob(audioBase64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const audioBlob = new Blob([bytes], { type: "audio/wav" });

      // ── Step 3: Upload WAV to Supabase Storage (browser-side, with user auth) ──
      const storagePath = `${this.userId}/audio/${this.bookId}/page_${pageNumber}.wav`;

      const { error: uploadErr } = await supabase.storage
        .from("books")
        .upload(storagePath, audioBlob, {
          contentType: "audio/wav",
          upsert: true,
        });

      if (uploadErr) {
        console.error(`[AudioPregen] Storage upload FAILED for page ${pageNumber}:`, uploadErr.message);
        // Still mark as error but don't crash the queue
        return false;
      }

      console.log(`[AudioPregen] Uploaded page ${pageNumber} to Storage: ${storagePath}`);

      // ── Step 4: Save metadata to page_audio_cache table ──
      const { error: dbErr } = await supabase
        .from("page_audio_cache")
        .upsert(
          {
            book_id: this.bookId,
            user_id: this.userId,
            page_number: pageNumber,
            voice: this.voice,
            audio_storage_path: storagePath,
            duration_seconds: duration,
            word_timings: timings,
            status: "ready",
          },
          { onConflict: "book_id,page_number,voice" }
        );

      if (dbErr) {
        console.warn(`[AudioPregen] DB upsert failed for page ${pageNumber}:`, dbErr.message);
        // Storage upload succeeded, so still mark as ready
      }

      // ── Step 5: Update in-memory cache (lightweight, no audio blob) ──
      this.cache.set(key, {
        pageNumber,
        status: "ready",
        storagePath,
        duration,
        timings,
      });

      return true;
    } catch (e: any) {
      if (e.name === "AbortError") return false;
      console.error(`[AudioPregen] Error generating page ${pageNumber}:`, e);
      return false;
    }
  }

  private async waitForRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
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
