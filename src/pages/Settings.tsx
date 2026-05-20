import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/use-toast";
import {
  Key, ExternalLink, Eye, EyeOff, CheckCircle2, AlertCircle,
  Loader2, Info, ShieldCheck, Zap, DollarSign,
} from "lucide-react";

export default function Settings() {
  const { user } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  
  const [elApiKey, setElApiKey] = useState("");
  const [showElKey, setShowElKey] = useState(false);
  const [hasElKey, setHasElKey] = useState(false);
  
  const [loading, setLoading] = useState(true);

  // Load existing key
  useEffect(() => {
    const storedKey = localStorage.getItem("groq_api_key");
    if (storedKey) {
      setApiKey(storedKey);
      setHasKey(true);
    }
    const storedElKey = localStorage.getItem("elevenlabs_api_key");
    if (storedElKey) {
      setElApiKey(storedElKey);
      setHasElKey(true);
    }
    setLoading(false);
  }, []);

  const saveKey = () => {
    if (!apiKey.trim().startsWith("gsk_")) {
      toast({ title: "Invalid key", description: "Groq API keys start with 'gsk_'", variant: "destructive" });
      return;
    }
    setSaving(true);
    
    // Save to local storage instead of Supabase
    localStorage.setItem("groq_api_key", apiKey.trim());
    setHasKey(true);
    toast({ title: "API key saved! ✅", description: "You can now use Groq Orpheus TTS." });
    
    setSaving(false);
  };

  const removeKey = () => {
    setSaving(true);
    localStorage.removeItem("groq_api_key");
    setApiKey("");
    setHasKey(false);
    toast({ title: "API key removed" });
    setSaving(false);
  };

  const saveElKey = () => {
    setSaving(true);
    localStorage.setItem("elevenlabs_api_key", elApiKey.trim());
    setHasElKey(true);
    toast({ title: "ElevenLabs API key saved! ✅", description: "Fallback TTS is ready." });
    setSaving(false);
  };

  const removeElKey = () => {
    setSaving(true);
    localStorage.removeItem("elevenlabs_api_key");
    setElApiKey("");
    setHasElKey(false);
    toast({ title: "ElevenLabs API key removed" });
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="mx-auto px-4 sm:px-6 py-6 sm:py-10 max-w-2xl">
      <h1 className="text-2xl sm:text-3xl font-bold mb-2">Settings</h1>
      <p className="text-muted-foreground mb-8">Configure your audiobook experience.</p>

      {/* ---- Groq API Key Section ---- */}
      <Card className="p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Key className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">Groq API Key</h2>
            <p className="text-sm text-muted-foreground">Required for AI-powered narration</p>
          </div>
          {hasKey && (
            <div className="ml-auto flex items-center gap-1 text-green-600">
              <CheckCircle2 className="w-4 h-4" />
              <span className="text-xs font-medium">Active</span>
            </div>
          )}
        </div>

        {/* Key input */}
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              placeholder="gsk_xxxxxxxxxxxx..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="pr-10 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <Button onClick={saveKey} disabled={saving || !apiKey.trim()}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </Button>
          {hasKey && (
            <Button variant="outline" onClick={removeKey} disabled={saving}>
              Remove
            </Button>
          )}
        </div>

        {/* Step-by-step guide */}
        <div className="bg-accent/30 rounded-lg p-4 sm:p-5 space-y-4 border border-border/50">
          <h3 className="font-medium text-sm flex items-center gap-2">
            <Info className="w-4 h-4 text-primary" />
            How to get your Groq API key
          </h3>

          <ol className="space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">1</span>
              <div>
                <span className="text-foreground font-medium">Create a free Groq account</span>
                <br />
                Go to{" "}
                <a
                  href="https://console.groq.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1"
                >
                  console.groq.com <ExternalLink className="w-3 h-3" />
                </a>{" "}
                and sign up with Google or email.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">2</span>
              <div>
                <span className="text-foreground font-medium">Accept the Terms of Use</span>
                <br />
                When prompted, accept Groq's{" "}
                <a
                  href="https://groq.com/terms-of-use/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1"
                >
                  Terms of Use <ExternalLink className="w-3 h-3" />
                </a>{" "}
                and{" "}
                <a
                  href="https://groq.com/privacy-policy/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1"
                >
                  Privacy Policy <ExternalLink className="w-3 h-3" />
                </a>.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">3</span>
              <div>
                <span className="text-foreground font-medium">Generate an API key</span>
                <br />
                Navigate to{" "}
                <a
                  href="https://console.groq.com/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-1"
                >
                  API Keys <ExternalLink className="w-3 h-3" />
                </a>
                {" "}→ Create API Key → Copy the key (starts with <code className="bg-muted px-1 rounded text-xs">gsk_</code>).
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">4</span>
              <div>
                <span className="text-foreground font-medium">Paste it above and click Save</span>
              </div>
            </li>
          </ol>
        </div>

        {/* Pricing & Limits info */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-accent/20 rounded-lg p-3 border border-border/30">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="w-4 h-4 text-green-600" />
              <span className="font-medium text-sm">Pricing</span>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground font-semibold">Free tier</span> includes generous daily usage. Paid plans start at $0.05 per 1M characters.
            </p>
          </div>

          <div className="bg-accent/20 rounded-lg p-3 border border-border/30">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="w-4 h-4 text-amber-600" />
              <span className="font-medium text-sm">Rate Limits</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Free tier: <span className="text-foreground font-semibold">~20 requests/min</span>. If you hit limits, the app auto-switches to browser TTS.
            </p>
          </div>

          <div className="bg-accent/20 rounded-lg p-3 border border-border/30">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="w-4 h-4 text-blue-600" />
              <span className="font-medium text-sm">Security</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Your key is stored securely and <span className="text-foreground font-semibold">never shared</span>. Only used for TTS generation.
            </p>
          </div>
        </div>

        {/* No key warning */}
        {!hasKey && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
            <p className="text-sm text-destructive">
              Without a Groq API key, you can only use <strong>Browser TTS</strong> (lower quality, works offline). 
              Add your key to unlock AI-powered narration with natural voices.
            </p>
          </div>
        )}
      </Card>

      {/* ---- ElevenLabs API Key Section ---- */}
      <Card className="p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Key className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">ElevenLabs API Key (Optional)</h2>
            <p className="text-sm text-muted-foreground">Fallback TTS if Groq limits are reached</p>
          </div>
          {hasElKey && (
            <div className="ml-auto flex items-center gap-1 text-green-600">
              <CheckCircle2 className="w-4 h-4" />
              <span className="text-xs font-medium">Active</span>
            </div>
          )}
        </div>

        {/* Key input */}
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Input
              type={showElKey ? "text" : "password"}
              placeholder="sk_xxxxxxxxxxxx..."
              value={elApiKey}
              onChange={(e) => setElApiKey(e.target.value)}
              className="pr-10 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowElKey(!showElKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showElKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <Button onClick={saveElKey} disabled={saving || !elApiKey.trim()}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
          </Button>
          {hasElKey && (
            <Button variant="outline" onClick={removeElKey} disabled={saving}>
              Remove
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
