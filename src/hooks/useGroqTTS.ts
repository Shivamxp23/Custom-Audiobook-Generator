import { useCallback, useEffect, useRef, useState } from "react";
import { audioPregenService } from "@/lib/audioPregenService";

export interface GroqVoicePreset {
  voice: string;
  label: string;
}

// Orpheus voices available on Groq
export const GROQ_VOICE_PRESETS: Record<string, GroqVoicePreset> = {
  daniel: { voice: "daniel", label: "Daniel (British)" },
  aaron:  { voice: "aaron",  label: "Aaron (American)" },
  lisa:   { voice: "lisa",   label: "Lisa (American)" },
  sarah:  { voice: "sarah",  label: "Sarah (British)" },
};

interface WordTiming {
  start: number;
  end: number;
}

interface Chunk {
  startWord: number;
  endWord: number;
  text: string;
  words: string[];
  apiKey?: string;
}

interface FetchResult {
  audioUrl: string;
  timings: WordTiming[];
}

const WORDS_PER_CHUNK = 120;
const MIN_REQUEST_INTERVAL_MS = 5000;

function splitIntoChunks(words: string[], startFrom: number, apiKey?: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (let i = startFrom; i < words.length; i += WORDS_PER_CHUNK) {
    const end = Math.min(i + WORDS_PER_CHUNK, words.length);
    const slice = words.slice(i, end);
    const text = slice.join(" ");
    if (text.length > 3800) {
      const mid = Math.floor(slice.length / 2);
      chunks.push({ startWord: i, endWord: i + mid - 1, text: slice.slice(0, mid).join(" "), words: slice.slice(0, mid), apiKey });
      chunks.push({ startWord: i + mid, endWord: end - 1, text: slice.slice(mid).join(" "), words: slice.slice(mid), apiKey });
    } else {
      chunks.push({ startWord: i, endWord: end - 1, text, words: slice, apiKey });
    }
  }
  return chunks;
}

function findWordAtTime(timings: WordTiming[], time: number): number {
  if (timings.length === 0) return 0;
  if (time < timings[0].start) return 0;
  if (time >= timings[timings.length - 1].start) return timings.length - 1;

  let lo = 0;
  let hi = timings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (time >= timings[mid].start && time < (timings[mid + 1]?.start ?? Infinity)) {
      return mid;
    } else if (time < timings[mid].start) {
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

function generateFallbackTimings(words: string[], duration: number): WordTiming[] {
  if (words.length === 0 || duration <= 0) return [];

  const weights = words.map(w => {
    let weight = w.length;
    if (/[.!?]$/.test(w)) weight += 4;
    else if (/[,;:]$/.test(w)) weight += 2;
    return weight;
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const timings: WordTiming[] = [];
  let cursor = 0;

  for (let i = 0; i < words.length; i++) {
    const wordDuration = (weights[i] / totalWeight) * duration;
    timings.push({ start: cursor, end: cursor + wordDuration });
    cursor += wordDuration;
  }

  return timings;
}

export function useGroqTTS() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onPageEndRef = useRef<(() => void) | null>(null);
  const chunksRef = useRef<Chunk[]>([]);
  const currentChunkRef = useRef(0);
  const presetRef = useRef<GroqVoicePreset>(GROQ_VOICE_PRESETS.daniel);
  const rateRef = useRef(1);
  const timingsRef = useRef<WordTiming[]>([]);
  const fetchCache = useRef<Map<string, FetchResult>>(new Map());
  const lastRequestTimeRef = useRef(0);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.ontimeupdate = null;
    }
  }, []);

  const waitForRateLimit = useCallback(async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTimeRef.current;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      const waitTime = MIN_REQUEST_INTERVAL_MS - elapsed;
      await new Promise(r => setTimeout(r, waitTime));
    }
    lastRequestTimeRef.current = Date.now();
  }, []);

  const fetchAudioAndTimings = useCallback(async (chunk: Chunk): Promise<FetchResult | null> => {
    const apiKeyKey = chunk.apiKey ? `custom-key` : `env-key`;
    const cacheKey = `${apiKeyKey}:${presetRef.current.voice}:${chunk.text}`;
    const cached = fetchCache.current.get(cacheKey);
    if (cached) return cached;

    try {
      await waitForRateLimit();

      const requestBody = {
        text: chunk.text,
        voice: presetRef.current.voice,
        apiKey: chunk.apiKey,
      };

      const resp = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: abortRef.current?.signal,
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(`TTS failed (${resp.status}): ${errData.error || JSON.stringify(errData)}`);
      }

      const json = await resp.json();
      
      const base64Response = await fetch(`data:audio/wav;base64,${json.audio}`);
      const blob = await base64Response.blob();
      const audioUrl = URL.createObjectURL(blob);

      let timings: WordTiming[] = json.timings || [];
      if (timings.length === 0 && json.duration) {
        timings = generateFallbackTimings(chunk.words, json.duration);
      }

      const result: FetchResult = { audioUrl, timings };
      fetchCache.current.set(cacheKey, result);
      return result;
    } catch (e: any) {
      if (e.name === "AbortError") return null;
      setError(e.message);
      return null;
    }
  }, [waitForRateLimit]);

  const playChunk = useCallback(async (idx: number) => {
    const chunks = chunksRef.current;
    if (idx >= chunks.length) {
      setIsPlaying(false);
      setIsLoading(false);
      onPageEndRef.current?.();
      return;
    }

    currentChunkRef.current = idx;
    const chunk = chunks[idx];
    setCurrentWordIndex(chunk.startWord);
    setIsLoading(true);

    const result = await fetchAudioAndTimings(chunk);
    if (!result) {
      setIsLoading(false);
      setIsPlaying(false);
      return;
    }

    if (idx + 1 < chunks.length) {
      setTimeout(() => {
        if (currentChunkRef.current === idx) {
          fetchAudioAndTimings(chunks[idx + 1]).catch(() => {});
        }
      }, MIN_REQUEST_INTERVAL_MS + 2000);
    }

    setIsLoading(false);
    timingsRef.current = result.timings;

    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = result.audioUrl;
    audioRef.current.playbackRate = rateRef.current;

    audioRef.current.ontimeupdate = () => {
      if (!audioRef.current) return;
      const currentTime = audioRef.current.currentTime;
      const timings = timingsRef.current;

      if (timings.length > 0) {
        const wordOffset = findWordAtTime(timings, currentTime);
        setCurrentWordIndex(chunk.startWord + Math.min(wordOffset, chunk.words.length - 1));
      } else {
        const progress = currentTime / (audioRef.current.duration || 1);
        const wordOffset = Math.floor(progress * chunk.words.length);
        setCurrentWordIndex(chunk.startWord + Math.min(wordOffset, chunk.words.length - 1));
      }
    };

    audioRef.current.onended = () => playChunk(idx + 1);
    audioRef.current.onerror = () => {
      console.error("Audio playback error, skipping chunk");
      playChunk(idx + 1);
    };

    try {
      await audioRef.current.play();
    } catch {
      setIsPlaying(false);
    }
  }, [fetchAudioAndTimings]);

  /**
   * Play a full page from a pre-generated audio URL (downloaded from Supabase Storage).
   */
  const playCachedPage = useCallback(async (
    audioUrl: string,
    timings: WordTiming[],
    words: string[],
    startFrom: number,
    rate: number,
    onPageEnd?: () => void,
  ) => {
    cleanup();
    abortRef.current = new AbortController();
    onPageEndRef.current = onPageEnd || null;
    rateRef.current = rate;

    setIsPlaying(true);
    setIsLoading(false);
    setError(null);
    setCurrentWordIndex(startFrom);

    timingsRef.current = timings;

    if (!audioRef.current) audioRef.current = new Audio();
    audioRef.current.src = audioUrl;
    audioRef.current.playbackRate = rateRef.current;

    // If starting from a word offset, seek to that position
    if (startFrom > 0 && timings.length > startFrom) {
      audioRef.current.currentTime = timings[startFrom].start;
    }

    audioRef.current.ontimeupdate = () => {
      if (!audioRef.current) return;
      const currentTime = audioRef.current.currentTime;
      const t = timingsRef.current;

      if (t.length > 0) {
        const wordOffset = findWordAtTime(t, currentTime);
        setCurrentWordIndex(Math.min(wordOffset, words.length - 1));
      } else {
        const progress = currentTime / (audioRef.current.duration || 1);
        const wordOffset = Math.floor(progress * words.length);
        setCurrentWordIndex(Math.min(wordOffset, words.length - 1));
      }
    };

    audioRef.current.onended = () => {
      setIsPlaying(false);
      onPageEnd?.();
    };
    audioRef.current.onerror = () => {
      console.error("Cached audio playback error");
      setIsPlaying(false);
    };

    try {
      await audioRef.current.play();
      console.log("[TTS] Playing cached audio from Storage");
    } catch {
      setIsPlaying(false);
    }
  }, [cleanup]);

  const speak = useCallback((
    words: string[],
    startFrom: number,
    preset: GroqVoicePreset | string,
    rate: number,
    onPageEnd?: () => void,
    apiKey?: string,
    bookId?: string,
    pageNumber?: number
  ) => {
    cleanup();
    abortRef.current = new AbortController();
    onPageEndRef.current = onPageEnd || null;
    rateRef.current = rate;
    presetRef.current = typeof preset === "string"
      ? GROQ_VOICE_PRESETS[preset] || GROQ_VOICE_PRESETS.daniel
      : preset;
    
    setIsPlaying(true);
    setError(null);

    // ── Check if pre-generated audio exists in Supabase Storage ──
    if (bookId && pageNumber) {
      const cached = audioPregenService.getCachedAudio(bookId, pageNumber);
      if (cached && cached.storagePath) {
        console.log(`[TTS] Cache HIT page ${pageNumber} — downloading from Storage...`);
        setIsLoading(true);

        // Download audio from Supabase Storage, then play
        (async () => {
          const audioUrl = await audioPregenService.downloadPageAudio(cached.storagePath);
          if (audioUrl) {
            let timings: WordTiming[] = cached.timings || [];
            if (timings.length === 0 && cached.duration) {
              timings = generateFallbackTimings(words, cached.duration);
            }
            playCachedPage(audioUrl, timings, words, startFrom, rate, onPageEnd);
            return;
          }

          // Download failed — fall back to real-time
          console.warn(`[TTS] Storage download failed for page ${pageNumber}, falling back to real-time`);
          const chunks = splitIntoChunks(words, startFrom, apiKey);
          chunksRef.current = chunks;
          currentChunkRef.current = 0;
          playChunk(0);
        })();
        return;
      } else {
        console.log(`[TTS] Cache MISS page ${pageNumber} — using real-time generation`);
      }
    }

    // ── Fallback: chunk-based real-time generation ──
    const chunks = splitIntoChunks(words, startFrom, apiKey);
    chunksRef.current = chunks;
    currentChunkRef.current = 0;
    playChunk(0);
  }, [cleanup, playChunk, playCachedPage]);

  const stop = useCallback(() => {
    cleanup();
    setIsPlaying(false);
    setIsLoading(false);
  }, [cleanup]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play();
    setIsPlaying(true);
  }, []);

  const setRate = useCallback((r: number) => {
    rateRef.current = r;
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  return {
    isPlaying,
    isLoading,
    currentWordIndex,
    error,
    speak,
    stop,
    pause,
    resume,
    setRate,
  };
}
