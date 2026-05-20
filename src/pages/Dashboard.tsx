import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BookOpen, Clock, TrendingUp, Library as LibIcon, ArrowRight } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { format, subDays, startOfDay, formatDistanceToNow } from "date-fns";

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ books: 0, totalMin: 0, sessions: 0, pagesRead: 0 });
  const [chartData, setChartData] = useState<{ day: string; minutes: number }[]>([]);
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: books } = await supabase.from("books").select("*").order("last_opened_at", { ascending: false, nullsFirst: false });
      const since = subDays(new Date(), 13).toISOString();
      const { data: sessions } = await supabase.from("reading_sessions").select("*").gte("started_at", since);

      const totalSec = (books || []).reduce((a: number, b: any) => a + (b.total_read_seconds || 0), 0);
      const pagesRead = (sessions || []).reduce((a: number, s: any) => a + (s.pages_read || 0), 0);
      setStats({
        books: books?.length || 0,
        totalMin: Math.round(totalSec / 60),
        sessions: sessions?.length || 0,
        pagesRead,
      });

      const buckets: Record<string, number> = {};
      for (let i = 13; i >= 0; i--) {
        const d = format(subDays(new Date(), i), "MMM d");
        buckets[d] = 0;
      }
      (sessions || []).forEach((s: any) => {
        const d = format(startOfDay(new Date(s.started_at)), "MMM d");
        if (d in buckets) buckets[d] += Math.round((s.duration_seconds || 0) / 60);
      });
      setChartData(Object.entries(buckets).map(([day, minutes]) => ({ day, minutes })));
      setRecent((books || []).slice(0, 5));
    })();
  }, [user]);

  const cards = [
    { label: "Books", value: stats.books, icon: LibIcon, color: "from-amber-500 to-orange-600" },
    { label: "Read time", value: `${stats.totalMin}m`, icon: Clock, color: "from-emerald-500 to-teal-600" },
    { label: "Sessions", value: stats.sessions, icon: TrendingUp, color: "from-blue-500 to-indigo-600" },
    { label: "Pages", value: stats.pagesRead, icon: BookOpen, color: "from-purple-500 to-pink-600" },
  ];

  return (
    <div className="mx-auto px-3 sm:px-4 py-6 sm:py-8 max-w-5xl">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">Dashboard</h1>
      <p className="text-sm text-muted-foreground mb-4 sm:mb-6">Your reading insights.</p>

      {/* Stats grid — 2 cols mobile, 4 cols desktop */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className="p-3 sm:p-5 hover:shadow-[var(--shadow-book)] transition-shadow duration-300">
              <div className="flex items-center gap-2 sm:gap-3 mb-2 sm:mb-3">
                <div className={`p-2 sm:p-2.5 rounded-xl bg-gradient-to-br ${c.color}`}>
                  <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-white" />
                </div>
              </div>
              <p className="text-xl sm:text-2xl font-bold">{c.value}</p>
              <span className="text-[10px] sm:text-xs text-muted-foreground">{c.label}</span>
            </Card>
          );
        })}
      </div>

      {/* Chart */}
      <Card className="p-3 sm:p-5 mb-6 sm:mb-8 shadow-[var(--shadow-soft)]">
        <h2 className="font-semibold text-sm sm:text-base mb-3 sm:mb-4">Reading minutes — last 14 days</h2>
        <div className="h-48 sm:h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <XAxis dataKey="day" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" width={30} />
              <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="minutes" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Recent books */}
      <Card className="p-3 sm:p-5 shadow-[var(--shadow-soft)]">
        <div className="flex items-center justify-between mb-3 sm:mb-4">
          <h2 className="font-semibold text-sm sm:text-base">Recently opened</h2>
          <Link to="/library">
            <Button variant="ghost" size="sm" className="text-xs">
              All <ArrowRight className="w-3 h-3 ml-1" />
            </Button>
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((b) => (
              <li key={b.id} className="py-2.5 sm:py-3 flex items-center justify-between group">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{b.title}</p>
                  <p className="text-[10px] sm:text-xs text-muted-foreground">
                    Pg {b.current_page}/{b.total_pages} • {Math.round((b.total_read_seconds || 0) / 60)}m
                    {b.last_opened_at && <span className="hidden sm:inline"> • {formatDistanceToNow(new Date(b.last_opened_at))} ago</span>}
                  </p>
                </div>
                <Link to={`/read/${b.id}`}>
                  <Button variant="ghost" size="sm" className="text-xs opacity-70 group-hover:opacity-100 transition-opacity">
                    Open
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
