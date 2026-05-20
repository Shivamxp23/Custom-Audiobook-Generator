import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { GROQ_VOICE_PRESETS } from "@/hooks/useGroqTTS";
import { audioPregenService } from "@/lib/audioPregenService";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";
import { extractPdfPages, extractEpubPages } from "@/lib/textExtract";
import { Upload as UploadIcon, FileText, Headphones } from "lucide-react";

export default function Upload() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [voice, setVoice] = useState("celeste");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [progress, setProgress] = useState(0);

  const handleFile = (f: File | null) => {
    setFile(f);
    if (f && !title) setTitle(f.name.replace(/\.(pdf|epub)$/i, ""));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !user) return;
    const ext = file.name.toLowerCase().endsWith(".epub") ? "epub" : file.name.toLowerCase().endsWith(".pdf") ? "pdf" : null;
    if (!ext) { toast({ title: "Unsupported file", description: "Use .pdf or .epub", variant: "destructive" }); return; }

    setBusy(true);
    try {
      setStep("Uploading file…"); setProgress(20);
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("books").upload(path, file, {
        contentType: file.type || (ext === "pdf" ? "application/pdf" : "application/epub+zip"),
      });
      if (upErr) throw upErr;

      setStep("Extracting text…"); setProgress(50);
      const pages = ext === "pdf" ? await extractPdfPages(file) : await extractEpubPages(file);
      const totalWords = pages.reduce((a, p) => a + p.words.length, 0);

      setStep("Saving to library…"); setProgress(80);
      const { data: book, error: insErr } = await supabase.from("books").insert({
        user_id: user.id,
        title: title || file.name,
        author: author || null,
        file_type: ext,
        file_path: path,
        total_pages: pages.length,
        total_words: totalWords,
        voice_description: voice,
        tts_status: "generating",
        current_page: 1,
        current_word_index: 0,
        total_read_seconds: 0,
      }).select().single();
      if (insErr) throw insErr;

      // Start background audio pre-generation immediately
      setStep("Starting audio generation…"); setProgress(90);
      const { data: profile } = await supabase.from("profiles").select("groq_api_key").eq("user_id", user.id).single();
      const apiKey = profile?.groq_api_key || "";

      audioPregenService.start(
        book.id,
        user.id,
        pages.map(p => ({ page: p.page, text: p.text, words: p.words })),
        voice,
        apiKey
      );

      setProgress(100);
      toast({ title: "Book added!", description: "Audio is being generated in the background. Opening the reader…" });
      navigate(`/read/${book.id}`);
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto px-3 sm:px-4 py-6 sm:py-8 max-w-2xl">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1 sm:mb-2">Upload a book</h1>
      <p className="text-sm sm:text-base text-muted-foreground mb-4 sm:mb-6">
        PDF or EPUB. Audio is generated on-the-fly by Groq PlayAI TTS when you press play.
      </p>

      <Card className="p-4 sm:p-6 shadow-[var(--shadow-book)]">
        <form onSubmit={submit} className="space-y-4 sm:space-y-5">
          {/* File picker */}
          <label className="block cursor-pointer">
            <input type="file" accept=".pdf,.epub" hidden onChange={(e) => handleFile(e.target.files?.[0] || null)} />
            <div className="border-2 border-dashed border-border rounded-xl p-6 sm:p-8 text-center hover:bg-accent/30 transition-all duration-300 hover:border-primary/40">
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileText className="w-8 h-8 sm:w-10 sm:h-10 text-primary" />
                  <p className="font-medium text-sm sm:text-base truncate max-w-full">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <UploadIcon className="w-8 h-8 sm:w-10 sm:h-10" />
                  <p className="font-medium text-sm sm:text-base text-foreground">Choose PDF or EPUB</p>
                  <p className="text-xs">Tap to browse</p>
                </div>
              )}
            </div>
          </label>

          {/* Title + Author */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <Label htmlFor="title">Title</Label>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="author">Author</Label>
              <Input id="author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Optional" />
            </div>
          </div>

          {/* Voice picker */}
          <div>
            <Label className="flex items-center gap-2">
              <Headphones className="w-4 h-4" />
              Narrator voice
            </Label>
            <Select value={voice} onValueChange={setVoice}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(GROQ_VOICE_PRESETS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    <span className="font-medium">{v.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              Ultra-fast and high quality TTS powered by Groq and PlayAI.
            </p>
          </div>

          {/* Progress */}
          {busy && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <span className="sound-wave playing" style={{ height: 16 }}>
                  <span /><span /><span /><span /><span />
                </span>
                {step}
              </p>
              <Progress value={progress} />
            </div>
          )}

          <Button
            type="submit"
            className="w-full py-5 sm:py-6 text-sm sm:text-base rounded-xl"
            style={{ background: busy ? undefined : "var(--gradient-warm)" }}
            disabled={!file || busy}
          >
            {busy ? "Working…" : "Upload & start reading"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
