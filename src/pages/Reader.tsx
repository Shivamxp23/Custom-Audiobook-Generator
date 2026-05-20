import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useGroqTTS, GROQ_VOICE_PRESETS } from "@/hooks/useGroqTTS";
import { audioPregenService } from "@/lib/audioPregenService";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ChevronLeft, ChevronRight, Play, Pause, ArrowLeft, Loader2,
  Volume2, Settings2, Disc3, AlertCircle,
} from "lucide-react";
import { extractPdfPages, extractEpubPages, PageText } from "@/lib/textExtract";
import PdfPageRenderer from "@/components/PdfPageRenderer";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function Reader() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  // Groq TTS
  const groq = useGroqTTS();

  const [book, setBook] = useState<any>(null);
  const [pages, setPages] = useState<PageText[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [currentWordGlobal, setCurrentWordGlobal] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [voice, setVoice] = useState("celeste");
  const [rate, setRate] = useState(1);
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null);
  const [pdfNumPages, setPdfNumPages] = useState<number | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  const [personalApiKey, setPersonalApiKey] = useState("");

  // Background generation progress
  const [pregenProgress, setPregenProgress] = useState<{
    totalPages: number;
    completedPages: number;
    currentPage: number | null;
    status: "idle" | "generating" | "complete" | "error";
  } | null>(null);

  const sessionRef = useRef<{ id: string; startPage: number; startedAt: number } | null>(null);
  const lastSavedRef = useRef(0);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const savedWordIndexRef = useRef<number>(0);
  const savedPageRef = useRef<number>(1);
  const initialRestoreDoneRef = useRef(false);
  const currentPageRef = useRef(1);
  const currentWordGlobalRef = useRef(0);

  const isPdf = book?.file_type === "pdf";

  useEffect(() => {
    const measure = () => {
      if (readerContainerRef.current) {
        const w = readerContainerRef.current.clientWidth;
        setContainerWidth(w > 0 ? w : 700);
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [loading]);

  useEffect(() => {
    let silentAudio: HTMLAudioElement | null = null;
    let silentInterval: ReturnType<typeof setInterval> | null = null;

    if (playing) {
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: book?.title || "Audiobook",
          artist: book?.author || "PageVox",
          album: "Audiobook",
        });
        navigator.mediaSession.setActionHandler("play", () => setPlaying(true));
        navigator.mediaSession.setActionHandler("pause", () => stopAll());
        navigator.mediaSession.setActionHandler("nexttrack", () => goPage(1));
        navigator.mediaSession.setActionHandler("previoustrack", () => goPage(-1));
      }

      try {
        silentAudio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
        silentAudio.loop = true;
        silentAudio.volume = 0.01;
        silentAudio.play().catch(() => {});
      } catch {}

      silentInterval = setInterval(() => {
        if (silentAudio && silentAudio.paused) {
          silentAudio.play().catch(() => {});
        }
      }, 10000);
    }

    return () => {
      if (silentAudio) { silentAudio.pause(); silentAudio = null; }
      if (silentInterval) clearInterval(silentInterval);
    };
  }, [playing, book]);

  useEffect(() => {
    if (!id || !user) return;
    (async () => {
      setLoading(true);
      initialRestoreDoneRef.current = false;
      const { data: b } = await supabase.from("books").select("*").eq("id", id).single();
      if (!b) { toast({ title: "Book not found", variant: "destructive" }); navigate("/library"); return; }
      setBook(b);

      const { data: profile } = await supabase.from("profiles").select("groq_api_key").eq("user_id", user.id).single();
      
      // Check BOTH Supabase profiles AND localStorage for the API key
      const profileKey = profile?.groq_api_key || "";
      const localKey = localStorage.getItem("groq_api_key") || "";
      const resolvedApiKey = profileKey || localKey;
      
      if (resolvedApiKey) {
        setPersonalApiKey(resolvedApiKey);
        // Sync: if one source has it but not the other, fix it
        if (profileKey && !localKey) {
          localStorage.setItem("groq_api_key", profileKey);
        }
        if (localKey && !profileKey && user) {
          supabase.from("profiles").update({ groq_api_key: localKey }).eq("user_id", user.id).then(() => {});
        }
      }

      const savedPage = b.current_page || 1;
      const savedWordIdx = b.current_word_index || 0;
      setCurrentPage(savedPage);
      setCurrentWordGlobal(savedWordIdx);
      savedWordIndexRef.current = savedWordIdx;
      savedPageRef.current = savedPage;
      currentPageRef.current = savedPage;
      currentWordGlobalRef.current = savedWordIdx;

      if (b.voice_description && Object.keys(GROQ_VOICE_PRESETS).includes(b.voice_description)) {
        setVoice(b.voice_description);
      }

      const { data: blob, error } = await supabase.storage.from("books").download(b.file_path);
      if (error || !blob) { toast({ title: "File load failed", variant: "destructive" }); setLoading(false); return; }

      if (b.file_type === "pdf") {
        const url = URL.createObjectURL(blob);
        setPdfFileUrl(url);
      }

      const extracted = b.file_type === "pdf" ? await extractPdfPages(blob) : await extractEpubPages(blob);
      setPages(extracted);

      const { data: s } = await supabase.from("reading_sessions").insert({
        book_id: id, user_id: user.id, start_page: savedPage,
      }).select().single();
      if (s) sessionRef.current = { id: s.id, startPage: savedPage, startedAt: Date.now() };

      await supabase.from("books").update({ last_opened_at: new Date().toISOString() }).eq("id", id);

      // Start background audio pre-generation
      const bookVoice = b.voice_description && Object.keys(GROQ_VOICE_PRESETS).includes(b.voice_description)
        ? b.voice_description : "daniel";
      
      if (!resolvedApiKey) {
        console.warn("[Reader] No Groq API key found — pre-generation may fail. Set your key in Settings.");
      }

      audioPregenService.start(
        id,
        user.id,
        extracted.map(p => ({ page: p.page, text: p.text, words: p.words })),
        bookVoice,
        resolvedApiKey,
        (progress) => setPregenProgress(progress)
      );

      setLoading(false);
    })();

    return () => {
      const sess = sessionRef.current;
      if (sess && id) {
        const dur = Math.round((Date.now() - sess.startedAt) / 1000);
        supabase.from("reading_sessions").update({
          ended_at: new Date().toISOString(), duration_seconds: dur,
        }).eq("id", sess.id).then(() => {});
      }
    };
  }, [id, user?.id]);

  useEffect(() => {
    if (pages.length === 0 || initialRestoreDoneRef.current) return;

    const savedWordIdx = savedWordIndexRef.current;
    if (savedWordIdx <= 0) {
      initialRestoreDoneRef.current = true;
      return;
    }

    let acc = 0;
    let targetPage = 1;
    for (let i = 0; i < pages.length; i++) {
      if (savedWordIdx >= acc && savedWordIdx < acc + pages[i].words.length) {
        targetPage = i + 1;
        break;
      }
      acc += pages[i].words.length;
      if (i === pages.length - 1) targetPage = pages.length;
    }

    setCurrentPage(targetPage);
    setCurrentWordGlobal(savedWordIdx);
    initialRestoreDoneRef.current = true;
  }, [pages]);

  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  useEffect(() => { currentWordGlobalRef.current = currentWordGlobal; }, [currentWordGlobal]);

  useEffect(() => {
    const savePosition = () => {
      if (!id || !initialRestoreDoneRef.current) return;
      supabase.from("books").update({
        current_page: currentPageRef.current,
        current_word_index: currentWordGlobalRef.current,
      }).eq("id", id).then(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.hidden) savePosition();
    };
    const handleBeforeUnload = () => savePosition();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      savePosition();
    };
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => {
      if (!id || !initialRestoreDoneRef.current || Date.now() - lastSavedRef.current < 8000) return;
      lastSavedRef.current = Date.now();
      supabase.from("books").update({
        current_page: currentPageRef.current,
        current_word_index: currentWordGlobalRef.current,
      }).eq("id", id).then(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [id]);

  const pageWordOffsets = useMemo(() => {
    const offsets: number[] = [];
    let acc = 0;
    for (const p of pages) { offsets.push(acc); acc += p.words.length; }
    return offsets;
  }, [pages]);

  const currentPageData = pages[currentPage - 1];
  const pageStartGlobal = pageWordOffsets[currentPage - 1] ?? 0;

  const stopAll = useCallback(() => {
    groq.stop();
    setPlaying(false);
  }, [groq]);

  const advancePage = useCallback(() => {
    if (currentPage < pages.length) {
      const nextPageIdx = currentPage; 
      setCurrentPage(p => p + 1);
      setCurrentWordGlobal(pageWordOffsets[nextPageIdx] ?? 0);
      setTimeout(() => setPlaying(true), 100);
    } else {
      setPlaying(false);
      toast({ title: "Book complete! 🎉" });
    }
  }, [currentPage, pages.length, pageWordOffsets]);

  useEffect(() => {
    if (!playing || !currentPageData) return;

    const wordInPage = Math.max(0, currentWordGlobal - pageStartGlobal);
    const startFrom = Math.min(wordInPage, currentPageData.words.length - 1);

    // Prioritize current page in background generator
    if (id) {
      audioPregenService.prioritizePage(currentPage);
    }

    groq.speak(
      currentPageData.words,
      startFrom,
      voice,
      rate,
      advancePage,
      personalApiKey || undefined,
      id,           // bookId for cache lookup
      currentPage   // pageNumber for cache lookup
    );

    return () => {};
  }, [playing, currentPage]);

  useEffect(() => {
    if (groq.isPlaying || groq.isLoading) {
      setCurrentWordGlobal(pageStartGlobal + groq.currentWordIndex);
    }
  }, [groq.isPlaying, groq.isLoading, groq.currentWordIndex, pageStartGlobal]);

  useEffect(() => {
    groq.setRate(rate);
  }, [rate, groq]);

  useEffect(() => {
    return () => {
      groq.stop();
      if (pdfFileUrl) URL.revokeObjectURL(pdfFileUrl);
    };
  }, []);

  useEffect(() => {
    if (groq.error) {
      toast({ title: "TTS error", description: groq.error, variant: "destructive" });
      groq.stop();
      setPlaying(false);
    }
  }, [groq.error]);

  const togglePlay = () => {
    if (playing) {
      stopAll();
    } else {
      setPlaying(true);
    }
  };

  const goPage = (delta: number) => {
    stopAll();
    const next = Math.max(1, Math.min(pages.length, currentPage + delta));
    setCurrentPage(next);
    setCurrentWordGlobal(pageWordOffsets[next - 1] ?? 0);

    // Prioritize the target page in background generation
    if (id) {
      audioPregenService.prioritizePage(next);
    }
  };

  useEffect(() => {
    if (!isPdf && activeWordRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentWordGlobal, isPdf]);

  const wordInPage = currentWordGlobal - pageStartGlobal;
  let highlightedWordOnPage: number | null = null;
  if (playing || groq.isPlaying) {
    highlightedWordOnPage = wordInPage;
  }

  const resumeWordOnPage: number | null = (!playing && !groq.isPlaying && wordInPage > 0 && wordInPage < (currentPageData?.words.length ?? 0))
    ? wordInPage
    : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading book…</p>
      </div>
    );
  }

  const isActive = playing || groq.isPlaying;
  const isBuffering = groq.isLoading;

  // Check if current page has cached audio
  const currentPageCached = id ? audioPregenService.isPageReady(id, currentPage) : false;

  return (
    <div className="mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-24 sm:pb-28 max-w-4xl">
      <div className="flex items-center gap-2 mb-3 sm:mb-4">
        <Button variant="ghost" size="icon" onClick={() => { stopAll(); navigate("/library"); }} className="shrink-0 h-8 w-8 sm:h-9 sm:w-9">
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1 min-w-0 text-center">
          <h1 className="font-semibold text-sm sm:text-base truncate">{book?.title}</h1>
          {book?.author && <p className="text-xs text-muted-foreground truncate hidden sm:block">{book.author}</p>}
        </div>
        <Badge
          variant="default"
          className="text-[10px] sm:text-xs shrink-0"
        >
          Groq Orpheus
        </Badge>
      </div>

      {/* Background generation progress indicator */}
      {pregenProgress && pregenProgress.status === "generating" && (
        <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg bg-accent/30 text-xs">
          <Disc3 className="w-3.5 h-3.5 animate-spin text-primary/70" />
          <span className="text-muted-foreground">
            Pre-generating audio… {pregenProgress.completedPages}/{pregenProgress.totalPages} pages
          </span>
          <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-primary/50 rounded-full transition-all duration-500"
              style={{ width: `${Math.round((pregenProgress.completedPages / pregenProgress.totalPages) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Pre-generation error (e.g., 401 — no API key) */}
      {pregenProgress && pregenProgress.status === "error" && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-lg bg-destructive/10 border border-destructive/20 text-xs">
          <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
          <span className="text-destructive">
            Pre-generation failed — check your Groq API key in{" "}
            <button
              className="underline underline-offset-2 font-medium"
              onClick={() => navigate("/settings")}
            >
              Settings
            </button>.
            Audio will still play in real-time.
          </span>
        </div>
      )}

      {isBuffering && (
        <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-accent/50 text-sm">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-muted-foreground">Generating audio…</span>
        </div>
      )}

      <Card
        ref={readerContainerRef}
        className={cn(
          "shadow-[var(--shadow-book)] overflow-hidden",
          isPdf ? "p-0" : "p-4 sm:p-6 md:p-10 min-h-[45vh] sm:min-h-[55vh]"
        )}
      >
        {isPdf && pdfFileUrl ? (
          <PdfPageRenderer
            fileUrl={pdfFileUrl}
            pageNumber={currentPage}
            pageStartGlobal={pageStartGlobal}
            highlightedWordOnPage={highlightedWordOnPage}
            resumeWordOnPage={resumeWordOnPage}
            currentWordGlobal={currentWordGlobal}
            onWordClick={(globalIdx) => {
              stopAll();
              setCurrentWordGlobal(globalIdx);
            }}
            onDocumentLoad={(numPages) => setPdfNumPages(numPages)}
            width={containerWidth > 0 ? containerWidth : undefined}
          />
        ) : currentPageData ? (
          <p className="text-base sm:text-lg leading-[1.9] sm:leading-[2] font-serif-book tracking-wide">
            {currentPageData.words.map((w, i) => {
              const isActiveWord = i === highlightedWordOnPage;
              const isResumeWord = i === resumeWordOnPage && !isActiveWord;
              const globalIdx = pageStartGlobal + i;
              const isRead = globalIdx < currentWordGlobal && !isActiveWord && !isResumeWord;
              return (
                <span
                  key={i}
                  ref={isActiveWord ? activeWordRef : isResumeWord ? activeWordRef : null}
                  className={cn("reading-word", isActiveWord && "is-active", isResumeWord && "is-resume", isRead && "is-read")}
                  onClick={() => {
                    stopAll();
                    setCurrentWordGlobal(globalIdx);
                  }}
                >
                  {w}{" "}
                </span>
              );
            })}
          </p>
        ) : (
          <p className="text-muted-foreground text-center py-12">No content on this page.</p>
        )}
      </Card>

      <Card className="p-3 sm:p-4 mt-3 sm:mt-4 sticky bottom-2 sm:bottom-4 shadow-[var(--shadow-book)] z-30">
        <div className="flex items-center gap-2 sm:gap-3">
          <Button variant="outline" size="icon" onClick={() => goPage(-1)} disabled={currentPage <= 1} className="h-8 w-8 sm:h-9 sm:w-9 shrink-0">
            <ChevronLeft className="w-4 h-4" />
          </Button>

          <Button
            size="icon"
            onClick={togglePlay}
            className="h-10 w-10 sm:h-12 sm:w-12 rounded-full shrink-0"
            style={{ background: "var(--gradient-warm)" }}
            disabled={isBuffering}
          >
            {isBuffering ? (
              <Loader2 className="w-5 h-5 text-white animate-spin" />
            ) : isActive ? (
              <Pause className="w-5 h-5 text-white" />
            ) : (
              <Play className="w-5 h-5 ml-0.5 text-white" />
            )}
          </Button>

          <Button variant="outline" size="icon" onClick={() => goPage(1)} disabled={currentPage >= pages.length} className="h-8 w-8 sm:h-9 sm:w-9 shrink-0">
            <ChevronRight className="w-4 h-4" />
          </Button>

          <div className="flex-1 px-2 sm:px-3 min-w-0">
            <div className="flex justify-between text-[10px] sm:text-xs text-muted-foreground mb-1">
              <span>Page {currentPage}/{pages.length}</span>
              <span className="flex items-center gap-1">
                {currentPageCached && <span className="text-green-500" title="Audio cached">●</span>}
                <Volume2 className="w-3 h-3" />
                Groq Orpheus
              </span>
            </div>
            <Slider
              value={[currentPage]}
              min={1}
              max={Math.max(1, pages.length)}
              step={1}
              onValueChange={(v) => {
                stopAll();
                setCurrentPage(v[0]);
                setCurrentWordGlobal(pageWordOffsets[v[0] - 1] ?? 0);
                // Prioritize this page
                if (id) audioPregenService.prioritizePage(v[0]);
              }}
            />
          </div>

          <Button variant="ghost" size="icon" onClick={() => setShowSettings(!showSettings)} className="h-8 w-8 sm:h-9 sm:w-9 shrink-0">
            <Settings2 className="w-4 h-4" />
          </Button>
        </div>

        {showSettings && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Speed: {rate.toFixed(1)}×</label>
              <Slider value={[rate]} min={0.5} max={2.5} step={0.1} onValueChange={(v) => setRate(v[0])} />
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Voice</label>
              <Select value={voice} onValueChange={setVoice}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(GROQ_VOICE_PRESETS).map(([k, v]) => (
                    <SelectItem key={k} value={k}><span className="text-xs">{v.label}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="sm:col-span-2 mt-1">
              <label className="text-xs text-muted-foreground mb-1 block">Personal Groq API Key (Optional)</label>
              <Input
                type="password"
                placeholder="gsk_..."
                value={personalApiKey}
                onChange={(e) => setPersonalApiKey(e.target.value)}
                onBlur={async () => {
                  if (!user) return;
                  await supabase.from("profiles").update({ groq_api_key: personalApiKey }).eq("user_id", user.id);
                  toast({ title: "API Key saved securely to your account" });
                }}
                className="h-8 text-xs bg-background/50"
              />
              <p className="text-[10px] text-muted-foreground mt-1 text-right">Saved securely to your profile and syncs across devices.</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
