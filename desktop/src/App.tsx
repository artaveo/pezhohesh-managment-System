import { useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { Icon } from "./components/Icon";

const NAV = [
  { id: "dashboard", icon: "home", label: "داشبورد" },
  { id: "members", icon: "users", label: "اعضا" },
  { id: "memberships", icon: "card", label: "عضویت و تمدید" },
  { id: "receipts", icon: "receipt", label: "بل‌ها و رسیدها" },
  { id: "expenses", icon: "wallet", label: "مصارف" },
  { id: "books", icon: "book", label: "امانت کتاب" },
  { id: "reports", icon: "chart", label: "گزارش مالی" },
  { id: "pec", icon: "briefcase", label: "خدمات تحصیلی" },
  { id: "settings", icon: "settings", label: "تنظیمات" },
] as const;

type PageId = (typeof NAV)[number]["id"];

export default function App() {
  const [page, setPage] = useState<PageId>("dashboard");
  const current = NAV.find((n) => n.id === page)!;
  return (
    <div className="shell">
      <aside className="side glass">
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
              <Icon name={n.icon} size={19} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="content">
        {page === "dashboard" ? <Dashboard /> : (
          <>
            <h1>{current.label}</h1>
            {page === "settings" ? <Settings /> : <p className="glass muted">این بخش در مرحله‌های بعدی ساخته می‌شود.</p>}
          </>
        )}
      </main>
    </div>
  );
}
