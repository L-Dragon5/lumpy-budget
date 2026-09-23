import { NavLink, Outlet, useLocation } from "react-router";
import {
  BanknoteIcon, CalendarClockIcon, ChartColumnIcon, LayoutDashboardIcon, MoonIcon,
  PiggyBankIcon, ReceiptIcon, RepeatIcon, SettingsIcon, SparklesIcon, SunIcon, TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pageTitle } from "@/lib/pageTitle";

type Item = { to: string; label: string; icon: LucideIcon; end?: boolean };

/** Grouped by what you are looking at: the plan, the bills, the money coming in. */
const GROUPS: Item[][] = [
  [
    { to: "/", label: "Dashboard", icon: LayoutDashboardIcon, end: true },
    { to: "/forecast", label: "Forecast", icon: TrendingUpIcon },
    { to: "/reports", label: "Reports", icon: ChartColumnIcon },
  ],
  [
    { to: "/fixed-costs", label: "Fixed costs", icon: RepeatIcon },
    { to: "/lumpy", label: "Lumpy fund", icon: CalendarClockIcon },
    { to: "/expenses", label: "Expenses", icon: ReceiptIcon },
    { to: "/categorize", label: "Categorize", icon: SparklesIcon },
  ],
  [
    { to: "/income", label: "Income", icon: BanknoteIcon },
    { to: "/savings", label: "Savings", icon: PiggyBankIcon },
  ],
];

const SETTINGS: Item = { to: "/settings", label: "Settings", icon: SettingsIcon };

function NavItem({ item }: { item: Item }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          isActive && "bg-accent font-medium text-foreground",
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {item.label}
    </NavLink>
  );
}

/** The brand's gradient drifts back and forth; `.wordmark` in index.css is the whole animation. */
const Wordmark = () => <span className="wordmark">Lumpy</span>;

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("lumpy-theme");
    return saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("lumpy-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, setDark] as const;
}

export default function App() {
  const [dark, setDark] = useTheme();
  const { pathname } = useLocation();
  const items = [...GROUPS.flat(), SETTINGS];

  return (
    <div className="min-h-svh bg-background text-foreground md:flex">
      <title>{pageTitle(pathname)}</title>

      <aside className="sticky top-0 z-40 hidden h-svh w-56 shrink-0 flex-col gap-1 border-r bg-background px-3 py-4 md:flex">
        <NavLink to="/" className="px-3 pb-3 text-lg font-semibold tracking-tight">
          <Wordmark />
        </NavLink>
        {GROUPS.map((group, i) => (
          <nav key={group[0].to} className={cn("flex flex-col gap-1", i > 0 && "mt-4 border-t pt-4")}>
            {group.map((item) => (
              <NavItem key={item.to} item={item} />
            ))}
          </nav>
        ))}
        <div className="mt-auto flex items-center gap-1 border-t pt-4">
          <div className="flex-1">
            <NavItem item={SETTINGS} />
          </div>
          <Button variant="ghost" size="icon" onClick={() => setDark(!dark)} aria-label="Toggle theme">
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </aside>

      {/* ponytail: phones get the same links as one scrolling strip, not a drawer. */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur md:hidden">
        <div className="flex items-center gap-2 px-4 py-3">
          <NavLink to="/" className="text-lg font-semibold tracking-tight">
            <Wordmark />
          </NavLink>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            onClick={() => setDark(!dark)}
            aria-label="Toggle theme"
          >
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">
          {items.map((item) => (
            <NavItem key={item.to} item={item} />
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full min-w-0 max-w-7xl px-4 py-6">
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
