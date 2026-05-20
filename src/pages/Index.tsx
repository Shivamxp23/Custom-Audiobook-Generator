import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen, Upload, Headphones, BarChart3, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: Upload,
    title: "Upload Anything",
    desc: "Drop in any PDF or EPUB. We extract every word, every page — ready for narration in seconds.",
  },
  {
    icon: Headphones,
    title: "Listen Instantly",
    desc: "Powered by Groq Orpheus TTS with expressive vocal directions. Or use free browser voices offline.",
  },
  {
    icon: Sparkles,
    title: "Word-by-Word Highlighting",
    desc: "Follow along as each word lights up in sync with the narration. Click any word to jump there.",
  },
  {
    icon: BarChart3,
    title: "Track Everything",
    desc: "Reading time, pages read, sessions, and progress — all visualized on your personal dashboard.",
  },
  {
    icon: Zap,
    title: "Lightning Fast",
    desc: "Groq's LPU architecture generates audio in milliseconds. No waiting, no buffering.",
  },
  {
    icon: BookOpen,
    title: "Pick Up Anywhere",
    desc: "Your position is saved automatically. Resume on any device — phone, tablet, or desktop.",
  },
];

const steps = [
  { num: "01", title: "Upload", desc: "Choose a PDF or EPUB from your device" },
  { num: "02", title: "Generate", desc: "Orpheus TTS narrates with the right tone" },
  { num: "03", title: "Listen", desc: "Follow along with word-level highlighting" },
];

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) return null;

  return (
    <div className="min-h-screen">
      {/* ─── Hero ─── */}
      <section className="hero-gradient min-h-screen flex flex-col">
        <header className="container mx-auto px-4 py-5 flex items-center justify-between relative z-10">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg" style={{ background: "var(--gradient-warm)" }}>
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-white tracking-tight">Audible Pages</span>
          </div>
          <Link to={user ? "/library" : "/auth"}>
            <Button variant="outline" className="border-white/20 text-white hover:bg-white/10 hover:text-white bg-transparent">
              {user ? "Go to Library" : "Sign In"}
            </Button>
          </Link>
        </header>

        <div className="flex-1 flex items-center justify-center relative z-10">
          <div className="container mx-auto px-4 text-center max-w-4xl">
            {/* Sound wave decoration */}
            <div className="flex justify-center mb-8 slide-up stagger-1">
              <div className="sound-wave playing">
                <span /><span /><span /><span /><span />
              </div>
            </div>

            <h1 className="text-4xl sm:text-5xl md:text-7xl font-extrabold text-white leading-[1.1] tracking-tight slide-up stagger-2">
              Turn Any Book Into
              <br />
              <span className="bg-gradient-to-r from-amber-400 via-orange-400 to-amber-500 bg-clip-text text-transparent">
                an Audiobook
              </span>
            </h1>

            <p className="mt-6 text-lg sm:text-xl text-white/60 max-w-2xl mx-auto leading-relaxed slide-up stagger-3">
              Upload a PDF or EPUB and start listening instantly with word-by-word highlighting.
              Powered by Groq Orpheus TTS. Works on any device.
            </p>

            <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center slide-up stagger-4">
              <Link to={user ? "/upload" : "/auth"}>
                <Button size="lg" className="text-base px-8 py-6 rounded-xl pulse-glow" style={{ background: "var(--gradient-warm)" }}>
                  <Upload className="w-5 h-5 mr-2" />
                  {user ? "Upload a Book" : "Get Started — It's Free"}
                </Button>
              </Link>
              {!user && (
                <Link to="/auth">
                  <Button size="lg" variant="outline" className="text-base px-8 py-6 rounded-xl border-white/20 text-white hover:bg-white/10 hover:text-white bg-transparent">
                    Sign In
                  </Button>
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="pb-8 flex justify-center relative z-10 fade-in" style={{ animationDelay: "1.5s", animationFillMode: "both" }}>
          <div className="w-6 h-10 rounded-full border-2 border-white/20 flex justify-center pt-2">
            <div className="w-1.5 h-3 rounded-full bg-white/40 animate-bounce" />
          </div>
        </div>
      </section>

      {/* ─── Features ─── */}
      <section className="py-20 sm:py-28" style={{ background: "var(--gradient-paper)" }}>
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">Everything you need to listen</h2>
            <p className="mt-3 text-lg text-muted-foreground max-w-xl mx-auto">
              A complete audiobook experience built for readers who want more.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {features.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="group p-6 rounded-2xl bg-card border border-border shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-book)] transition-all duration-300 hover:-translate-y-1"
                >
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-colors" style={{ background: "var(--gradient-warm)" }}>
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ─── How it works ─── */}
      <section className="py-20 bg-card border-y border-border">
        <div className="container mx-auto px-4">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">How it works</h2>
            <p className="mt-3 text-muted-foreground">Three steps to your personal audiobook.</p>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-8 sm:gap-16 max-w-3xl mx-auto">
            {steps.map((s, i) => (
              <div key={s.num} className="flex flex-col items-center text-center">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-extrabold text-white mb-4" style={{ background: "var(--gradient-warm)" }}>
                  {s.num}
                </div>
                <h3 className="font-semibold text-lg">{s.title}</h3>
                <p className="text-sm text-muted-foreground mt-1 max-w-[200px]">{s.desc}</p>
                {i < steps.length - 1 && (
                  <div className="hidden sm:block absolute">
                    {/* Arrow handled by gap */}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="hero-gradient py-20">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white tracking-tight mb-4">
            Ready to listen?
          </h2>
          <p className="text-white/60 text-lg mb-8 max-w-lg mx-auto">
            Upload your first book and experience reading in a whole new way.
          </p>
          <Link to={user ? "/upload" : "/auth"}>
            <Button size="lg" className="text-base px-10 py-6 rounded-xl" style={{ background: "var(--gradient-warm)" }}>
              {user ? "Upload a Book" : "Create Free Account"}
            </Button>
          </Link>
        </div>
      </section>

      {/* ─── Footer ─── */}
      <footer className="py-8 bg-card border-t border-border">
        <div className="container mx-auto px-4 flex items-center justify-between text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            <span className="font-medium">Audible Pages</span>
          </div>
          <p>Built with Groq Orpheus TTS</p>
        </div>
      </footer>
    </div>
  );
}
