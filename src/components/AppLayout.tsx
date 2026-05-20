import { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { BookOpen, LayoutDashboard, Library, Upload, LogOut, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/library", icon: Library, label: "Library" },
  { to: "/upload", icon: Upload, label: "Upload" },
  { to: "/dashboard", icon: LayoutDashboard, label: "Stats" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const { signOut } = useAuth();
  const loc = useLocation();
  const nav2 = useNavigate();
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--gradient-paper)" }}>
      {/* Top bar — desktop */}
      <header className="border-b border-border bg-card/70 backdrop-blur-lg sticky top-0 z-40">
        <div className="container mx-auto px-3 sm:px-4 h-14 sm:h-16 flex items-center justify-between">
          <Link to="/library" className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg" style={{ background: "var(--gradient-warm)" }}>
              <BookOpen className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <span className="font-bold text-base sm:text-lg tracking-tight hidden sm:inline">Audible Pages</span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {nav.map((n) => {
              const Icon = n.icon;
              const active = loc.pathname.startsWith(n.to);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200",
                    active ? "bg-accent text-accent-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                >
                  <Icon className="w-4 h-4" /> {n.label}
                </Link>
              );
            })}
          </nav>

          <Button
            variant="ghost"
            size="sm"
            onClick={async () => { await signOut(); nav2("/auth"); }}
            className="text-muted-foreground hover:text-foreground text-xs sm:text-sm"
          >
            <LogOut className="w-4 h-4 sm:mr-2" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </header>

      {/* Main content — leave room for mobile bottom nav */}
      <main className="flex-1 pb-16 md:pb-0">{children}</main>

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 flex items-center justify-around border-t border-border py-2 bg-card/90 backdrop-blur-lg z-40 safe-area-bottom">
        {nav.map((n) => {
          const Icon = n.icon;
          const active = loc.pathname.startsWith(n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                "flex flex-col items-center text-[11px] gap-0.5 py-1 px-3 rounded-lg transition-colors",
                active ? "text-primary font-semibold" : "text-muted-foreground"
              )}
            >
              <Icon className="w-5 h-5" />
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
