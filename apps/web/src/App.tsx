import { NavLink, Outlet, useLocation } from "react-router";
import { MoonIcon, SunIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import GradientText from "@/components/GradientText";
import { pageTitle } from "@/lib/pageTitle";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/income", label: "Income" },
  { to: "/fixed-costs", label: "Fixed costs" },
  { to: "/lumpy", label: "Lumpy fund" },
  { to: "/savings", label: "Savings" },
  { to: "/forecast", label: "Forecast" },
  { to: "/expenses", label: "Expenses" },
  { to: "/reports", label: "Reports" },
  { to: "/settings", label: "Settings" },
];

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

  return (
    <div className="min-h-svh bg-background text-foreground">
      <title>{pageTitle(pathname)}</title>
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <NavLink to="/" className="shrink-0 text-lg font-semibold tracking-tight">
            <GradientText colors={["#2a78d6", "#1baf7a", "#2a78d6"]} animationSpeed={9}>
              Lumpy
            </GradientText>
          </NavLink>
          <nav className="flex flex-1 flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    isActive && "bg-accent font-medium text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <Button variant="ghost" size="icon" onClick={() => setDark(!dark)} aria-label="Toggle theme">
            {dark ? <SunIcon /> : <MoonIcon />}
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
