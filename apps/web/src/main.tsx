import { StrictMode, lazy } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import Dashboard from "@/pages/Dashboard";
import "./index.css";

// The dashboard is where every visit lands, so it ships in the entry chunk; each
// other page (and recharts, which only Reports and the timeline use) loads on
// first visit. `<Suspense>` around the outlet in App.tsx keeps the sidebar up.
const Income = lazy(() => import("@/pages/Income"));
const FixedCosts = lazy(() => import("@/pages/FixedCosts"));
const LumpyFund = lazy(() => import("@/pages/LumpyFund"));
const LumpyTimeline = lazy(() => import("@/pages/LumpyTimeline"));
const Forecast = lazy(() => import("@/pages/Forecast"));
const Savings = lazy(() => import("@/pages/Savings"));
const Expenses = lazy(() => import("@/pages/Expenses"));
const Categorize = lazy(() => import("@/pages/Categorize"));
const Reports = lazy(() => import("@/pages/Reports"));
const Settings = lazy(() => import("@/pages/Settings"));
const NotFound = lazy(() => import("@/pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Dashboard />} />
            <Route path="income" element={<Income />} />
            <Route path="fixed-costs" element={<FixedCosts />} />
            <Route path="lumpy" element={<LumpyFund />} />
            <Route path="lumpy/timeline" element={<LumpyTimeline />} />
            <Route path="forecast" element={<Forecast />} />
            <Route path="savings" element={<Savings />} />
            <Route path="expenses" element={<Expenses />} />
            <Route path="categorize" element={<Categorize />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
