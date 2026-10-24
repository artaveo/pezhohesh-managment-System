import { useEffect, useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { LoansList, MembersList } from "./pages/DueLists";
import { ImportExcel } from "./pages/ImportExcel";
import { FirstSetup, ForcePasswordChange, Login, Offline } from "./pages/Login";
import { Icon } from "./components/Icon";
import { useAuth } from "./auth/AuthProvider";
import { useTheme } from "./theme/ThemeProvider";
import { api, ROLE_LABEL, type Role } from "./lib/api";

const ALL: Role[] = ["partner", "manager", "pec_staff"];
const HALL: Role[] = ["partner", "manager"];

// Which roles see each section. The API and the database enforce the same rules;
// hiding a section here only keeps the menu tidy.
const NAV = [
  { id: "dashboard", icon: "home", label: "داشبورد", roles: ALL },
  { id: "members", icon: "users", label: "اعضا", roles: HALL },
  { id: "memberships", icon: "card", label: "عضویت و تمدید", roles: HALL },
  { id: "receipts", icon: "receipt", label: "بل‌ها و رسیدها", roles: ALL },
  { id: "expenses", icon: "wallet", label: "مصارف", roles: ALL },
  { id: "books", icon: "book", label: "امانت کتاب", roles: HALL },
  { id: "reports", icon: "chart", label: "گزارش مالی", roles: HALL },
  { id: "pec", icon: "briefcase", label: "خدمات تحصیلی", roles: ["partner", "pec_staff"] as Role[] },
  { id: "users", icon: "shield", label: "کاربران", roles: ["partner"] as Role[] },
  { id: "import", icon: "upload", label: "ورود از اکسل", roles: ["partner"] as Role[] },
  { id: "settings", icon: "settings", label: "تنظیمات من", roles: ALL },
] as const;

type PageId = (typeof NAV)[number]["id"];

export default function App() {
  const { status, user, retry } = useAuth();
  if (status === "loading" || status === "offline") return <Offline onRetry={retry} loading={status === "loading"} />;
  if (status === "setup") return <FirstSetup />;
  if (status === "signed_out" || !user) return <Login />;
  if (user.must_change_password) return <ForcePasswordChange />;
  return <Shell />;
}

function Shell() {
  const { user, signOut } = useAuth();
  const { dark, setMode } = useTheme();
  const nav = NAV.filter((n) => (n.roles as readonly Role[]).includes(user!.role));
  const [page, setPage] = useState<PageId>("dashboard");
  useEffect(() => {
    if (!nav.some((n) => n.id === page)) setPage("dashboard");
  }, [user, nav, page]);
  const current = nav.find((n) => n.id === page) ?? nav[0];

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
          {nav.map((n) => (
            <button key={n.id} className={n.id === page ? "active" : ""} onClick={() => setPage(n.id)}>
              <Icon name={n.icon} size={19} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="side-user">
          <span className="avatar" aria-hidden="true">{user!.full_name.trim().charAt(0)}</span>
          <div>
            <strong>{user!.full_name}</strong>
            <span>{ROLE_LABEL[user!.role]}</span>
          </div>
          <button className="icon-btn" title={dark ? "حالت روشن" : "حالت تاریک"} aria-label={dark ? "حالت روشن" : "حالت تاریک"}
            onClick={() => { const m = dark ? "light" : "dark"; setMode(m); void api.setThemeMode(m).catch(() => {}); }}>
            <Icon name={dark ? "sun" : "moon"} size={18} />
          </button>
          <button className="icon-btn danger" title="خروج" aria-label="خروج" onClick={() => void signOut()}>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      <main className="content">
        {page === "dashboard" ? (
          user!.role === "pec_staff" ? <PecHome /> : <Dashboard go={setPage} />
        ) : (
          <>
            <h1>{current.label}</h1>
            {page === "settings" ? <Settings />
              : page === "users" ? <Users />
              : page === "members" ? <MembersList />
              : page === "books" ? <LoansList />
              : page === "import" ? <ImportExcel done={() => setPage("dashboard")} />
              : <p className="glass muted">این بخش در مرحله‌های بعدی ساخته می‌شود.</p>}
          </>
        )}
      </main>
    </div>
  );
}

function PecHome() {
  const { user } = useAuth();
  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <p className="eyebrow">خدمات تحصیلی</p>
          <h1>سلام {user!.full_name}</h1>
        </div>
      </header>
      <p className="glass muted">صفحهٔ اول خدمات تحصیلی (پرونده‌ها، قراردادها و پرداخت‌ها) در مرحله‌های بعدی ساخته می‌شود.</p>
    </div>
  );
}
