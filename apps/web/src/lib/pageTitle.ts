const TITLES: Record<string, string> = {
  "/": "Dashboard",
  "/income": "Income",
  "/fixed-costs": "Fixed costs",
  "/lumpy": "Lumpy fund",
  "/lumpy/timeline": "Lumpy timeline",
  "/savings": "Savings",
  "/expenses": "Expenses",
  "/reports": "Reports",
  "/settings": "Settings",
};

export function pageTitle(pathname: string): string {
  const name = TITLES[pathname.replace(/\/+$/, "") || "/"];
  return name ? `${name} · Lumpy` : "Lumpy";
}
