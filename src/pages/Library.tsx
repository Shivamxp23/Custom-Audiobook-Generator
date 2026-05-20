import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { BookOpen, Trash2, Plus, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface Book {
  id: string;
  title: string;
  author: string | null;
  file_type: string;
  current_page: number;
  total_pages: number;
  total_read_seconds: number;
  tts_status: string;
  tts_progress: number;
  last_opened_at: string | null;
  updated_at: string;
}

export default function Library() {
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from("books").select("*").order("updated_at", { ascending: false });
    setBooks(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel("books-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "books", filter: `user_id=eq.${user.id}` }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user]);

  const remove = async (id: string) => {
    if (!confirm("Delete this book and its audio?")) return;
    const { error } = await supabase.from("books").delete().eq("id", id);
    if (error) toast({ title: "Error", description: error.message, variant: "destructive" });
    else load();
  };

  return (
    <div className="mx-auto px-3 sm:px-4 py-6 sm:py-8 max-w-5xl">
      <div className="flex items-center justify-between mb-4 sm:mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your Library</h1>
          <p className="text-sm text-muted-foreground">Pick up where you left off.</p>
        </div>
        <Link to="/upload">
          <Button style={{ background: "var(--gradient-warm)" }} className="rounded-xl text-sm px-3 sm:px-4">
            <Plus className="w-4 h-4 mr-1 sm:mr-2" />
            <span className="hidden sm:inline">Add book</span>
            <span className="sm:hidden">Add</span>
          </Button>
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : books.length === 0 ? (
        <Card className="p-8 sm:p-12 text-center shadow-[var(--shadow-soft)]">
          <BookOpen className="w-10 h-10 sm:w-12 sm:h-12 mx-auto text-muted-foreground mb-3 sm:mb-4" />
          <h3 className="font-semibold text-base sm:text-lg mb-1">No books yet</h3>
          <p className="text-sm text-muted-foreground mb-4">Upload a PDF or EPUB to start listening.</p>
          <Link to="/upload">
            <Button style={{ background: "var(--gradient-warm)" }} className="rounded-xl">Upload your first book</Button>
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
          {books.map((b) => (
            <Card key={b.id} className="p-4 sm:p-5 shadow-[var(--shadow-soft)] hover:shadow-[var(--shadow-book)] transition-all duration-300 group hover:-translate-y-0.5">
              <div className="flex items-start justify-between gap-2 mb-2 sm:mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-sm sm:text-base truncate">{b.title}</h3>
                  {b.author && <p className="text-xs sm:text-sm text-muted-foreground truncate">{b.author}</p>}
                </div>
                <Badge variant="secondary" className="uppercase text-[10px] shrink-0">{b.file_type}</Badge>
              </div>
              <div className="space-y-1 mb-3 sm:mb-4">
                <div className="flex justify-between text-[10px] sm:text-xs text-muted-foreground">
                  <span>Page {b.current_page}/{b.total_pages || "?"}</span>
                  <span>{Math.round((b.total_read_seconds || 0) / 60)} min</span>
                </div>
                <Progress value={b.total_pages ? (b.current_page / b.total_pages) * 100 : 0} className="h-1.5" />
                {b.last_opened_at && (
                  <p className="text-[10px] sm:text-xs text-muted-foreground">
                    Opened {formatDistanceToNow(new Date(b.last_opened_at))} ago
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Link to={`/read/${b.id}`} className="flex-1">
                  <Button className="w-full rounded-lg text-sm" variant="default">Open</Button>
                </Link>
                <Button variant="ghost" size="icon" onClick={() => remove(b.id)} className="text-muted-foreground hover:text-destructive h-9 w-9">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
