import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import Dashboard from "@/pages/Dashboard";
import Income from "@/pages/Income";
import FixedCosts from "@/pages/FixedCosts";
import LumpyFund from "@/pages/LumpyFund";
import LumpyTimeline from "@/pages/LumpyTimeline";
import Savings from "@/pages/Savings";
import Expenses from "@/pages/Expenses";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";
import "./index.css";

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
            <Route path="savings" element={<Savings />} />
            <Route path="expenses" element={<Expenses />} />
            <Route path="reports" element={<Reports />} />
            <Route path="settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  </StrictMode>,
);
