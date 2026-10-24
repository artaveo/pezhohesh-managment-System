import { useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";

const NAV = [
  { id: "dashboard", label: "داشبورد" },
  { id: "members", label: "اعضا" },
  { id: "memberships", label: "عضویت و تمدید" },
  { id: "receipts", label: "بل‌ها و رسیدها" },
  { id: "expenses", label: "مصارف" },
  { id: "books", label: "امانت کتاب" },
  { id: "reports", label: "گزارش مالی" },
  { id: "pec", label: "خدمات تحصیلی" },
  { id: "settings", label: "تنظیمات" },
] as const;

type PageId = (typeof NAV)[number]["id"];

export default function App() {
  const [page, setPage] = useState<PageId>("dashboard");
  const current = NAV.find((n) => n.id === page)!;
  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <img src="/logo-study-hall.png" alt="" />
          <div>
            <strong>پژوهش</strong>
            <span>سیستم مدیریت</span>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={n.id === page ? "active" : ""} onClick={() => setPage(n.id)}>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        <h1>{current.label}</h1>
        {page === "dashboard" ? <Dashboard /> : page === "settings" ? <Settings /> : <p className="muted">این بخش در مرحله‌های بعدی ساخته می‌شود.</p>}
      </main>
    </div>
  );
}
