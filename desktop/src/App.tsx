import { useEffect, useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { MembersList } from "./pages/DueLists";
import { Books } from "./pages/Books";
import { Hotspot } from "./pages/Hotspot";
import { Shares } from "./pages/Shares";
import { ImportExcel } from "./pages/ImportExcel";
import { Desk } from "./pages/members/Desk";
import { MemberPage } from "./pages/members/MemberPage";
import { NewMember } from "./pages/members/NewMember";
import { Bills } from "./pages/Bills";
import { Money } from "./pages/Money";
import { Prices } from "./pages/Prices";
import { FirstSetup, ForcePasswordChange, Login } from "./pages/Login";
import { Offline } from "./pages/Offline";
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
  { id: "memberships", icon: "card", label: "پذیرش و تمدید", roles: HALL },
  { id: "receipts", icon: "receipt", label: "بل‌ها", roles: HALL },
  { id: "expenses", icon: "wallet", label: "مصارف و برداشت‌ها", roles: HALL },
  { id: "books", icon: "book", label: "امانت کتاب", roles: HALL },
  { id: "hotspot", icon: "wifi", label: "کارت هاتسپات", roles: HALL },
  { id: "reports", icon: "chart", label: "گزارش مالی", roles: HALL },
  { id: "pec", icon: "briefcase", label: "خدمات تحصیلی", roles: ["partner", "pec_staff"] as Role[] },
  { id: "shares", icon: "pie", label: "سهم شرکا", roles: ["partner"] as Role[] },
  { id: "users", icon: "shield", label: "کاربران", roles: ["partner"] as Role[] },
  { id: "prices", icon: "settings", label: "قیمت‌ها", roles: ["partner"] as Role[] },
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
  const [page, setPageId] = useState<PageId>("dashboard");
  // Inside "members": one member's page, or the new-member form (with the bill to show after saving).
  const [member, setMember] = useState<{ id: string | null; bill?: string | null } | null>(null);
  const setPage = (id: PageId) => { setPageId(id); setMember(null); };
  const openMember = (id: string, bill: string | null = null) => { setPageId("members"); setMember({ id, bill }); };
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
            <h1>{member?.id === null ? "عضو جدید" : current.label}</h1>
            {page === "settings" ? <Settings />
              : page === "users" ? <Users />
              : page === "members" && member?.id ? <MemberPage key={member.id} id={member.id} openBill={member.bill} onBack={() => setMember(null)} />
              : page === "members" && member ? <NewMember onSaved={(id, bill) => openMember(id, bill)} onCancel={() => setMember(null)} />
              : page === "members" ? <MembersList open={(id) => openMember(id)} add={() => setMember({ id: null })} />
              : page === "memberships" ? <Desk openMember={(id) => openMember(id)} newMember={() => { setPageId("members"); setMember({ id: null }); }} />
              : page === "receipts" ? <Bills />
              : page === "expenses" ? <Money />
              : page === "prices" ? <Prices />
              : page === "books" ? <Books />
              : page === "hotspot" ? <Hotspot />
              : page === "shares" ? <Shares />
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
