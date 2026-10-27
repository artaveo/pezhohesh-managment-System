import { useEffect, useMemo, useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { Users } from "./pages/Users";
import { MembersList } from "./pages/DueLists";
import { Books } from "./pages/Books";
import { Hotspot } from "./pages/Hotspot";
import { Backup } from "./pages/Backup";
import { Device } from "./pages/Device";
import { Registrations, type RegFilter } from "./pages/Registrations";
import type { RegKind } from "./lib/api";
import { ImportExcel } from "./pages/ImportExcel";
import { Desk } from "./pages/members/Desk";
import { MemberPage } from "./pages/members/MemberPage";
import { NewMember } from "./pages/members/NewMember";
import { Bills } from "./pages/Bills";
import { Money } from "./pages/Money";
import { Prices } from "./pages/Prices";
import { Audit } from "./pages/Audit";
import { FirstSetup, ForcePasswordChange, Login } from "./pages/Login";
import { Offline } from "./pages/Offline";
import { Icon } from "./components/Icon";
import { useAuth } from "./auth/AuthProvider";
import { useTheme } from "./theme/ThemeProvider";
import { api, ROLE_LABEL, type Section, type User } from "./lib/api";
import { Inbox } from "./pages/Inbox";

/**
 * The menu. A section with `section` is shown to the roles a partner gave it to on the users
 * page (partners see all); `partner` sections are for partners only. The API checks the
 * same thing; hiding a section here only keeps the menu tidy. Grouped as the work is: the
 * desk, the money, the education department, running the system.
 */
type NavItem = { id: string; icon: string; label: string; group: string; section?: Section; also?: readonly Section[]; partner?: true; soon?: true };
export const NAV = [
  { id: "dashboard", icon: "home", label: "داشبورد", group: "" },
  { id: "memberships", icon: "card", label: "پذیرش و تمدید", section: "memberships", group: "کار روزانه" },
  { id: "members", icon: "users", label: "اعضا", section: "members", group: "کار روزانه" },
  { id: "registrations", icon: "userPlus", label: "ثبت‌نام‌ها", section: "registrations", group: "کار روزانه" },
  { id: "inbox", icon: "phone", label: "رسیده از موبایل", section: "inbox", group: "کار روزانه" },
  { id: "books", icon: "book", label: "امانت کتاب", section: "books", group: "کار روزانه" },
  { id: "hotspot", icon: "wifi", label: "کارت هاتسپات", section: "hotspot", group: "کار روزانه" },
  { id: "receipts", icon: "receipt", label: "بل‌ها", section: "receipts", group: "حساب و پول" },
  // Staff salaries and the partners' shares live inside it, under «برداشت‌ها».
  { id: "expenses", icon: "wallet", label: "مصارف و برداشت‌ها", section: "expenses", also: ["salaries", "shares"], group: "حساب و پول" },
  { id: "reports", icon: "chart", label: "گزارش مالی", section: "reports", group: "حساب و پول", soon: true },
  { id: "pec", icon: "cap", label: "خدمات تحصیلی", section: "pec", group: "خدمات تحصیلی", soon: true },
  { id: "audit", icon: "history", label: "چه کسی چه کرد", partner: true, group: "مدیریت" },
  { id: "users", icon: "shield", label: "کاربران", partner: true, group: "مدیریت" },
  { id: "prices", icon: "tag", label: "قیمت‌ها", partner: true, group: "مدیریت" },
  { id: "backup", icon: "database", label: "پشتیبان", partner: true, group: "مدیریت" },
  { id: "device", icon: "fingerprint", label: "دستگاه انگشت", partner: true, group: "مدیریت" },
  { id: "import", icon: "upload", label: "ورود از اکسل", partner: true, group: "مدیریت" },
  { id: "settings", icon: "user", label: "تنظیمات من", group: "" },
] as const satisfies readonly NavItem[];

/** Whether this person sees a menu item. */
function sees(user: User, n: NavItem) {
  if (user.role === "partner") return true;
  if (n.partner) return false;
  return !n.section || [n.section, ...(n.also ?? [])].some((s) => (user.sections ?? []).includes(s));
}

type PageId = (typeof NAV)[number]["id"];
/** Where the app is: a page, and inside "members" one member or the new-member form. */
type View = { page: PageId; member: { id: string | null; bill?: string | null } | null; reg?: RegFilter };

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
  const nav = useMemo(() => NAV.filter((n) => sees(user!, n)), [user]);
  const arrived = useInboxCount(nav.some((n) => n.id === "inbox"));
  const [view, setView] = useState<View>({ page: "dashboard", member: null });
  // Earlier views, for «برگشت» (and Alt+←), like a browser's history.
  const [history, setHistory] = useState<View[]>([]);
  const [listKey, setListKey] = useState(0);
  const go = (next: View) => {
    setHistory((h) => [...h.slice(-29), view]);
    setView(next);
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setView(prev);
  };
  const { page, member, reg } = view;
  const setPage = (id: PageId) => { if (id !== page || member) go({ page: id, member: null }); };
  const goFromDashboard = (id: "members" | "books" | "registrations", kind?: RegKind) =>
    go({ page: id, member: null, reg: id === "registrations" ? { span: "today", kind } : undefined });
  const openMember = (id: string, bill: string | null = null) => go({ page: "members", member: { id, bill } });
  useEffect(() => {
    if (!nav.some((n) => n.id === page)) setView({ page: "dashboard", member: null });
  }, [user, nav, page]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const current = nav.find((n) => n.id === page) ?? nav[0];
  const main = nav.filter((n) => n.id !== "settings");
  const groups = [...new Set(main.map((n) => n.group))];

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
        <nav aria-label="بخش‌ها">
          {groups.map((g) => (
            <div key={g || "top"} role="group" aria-label={g || "داشبورد"}>
              {g && <div className="nav-group">{g}</div>}
              {main.filter((n) => n.group === g).map((n) => (
                <button key={n.id} className={n.id === page ? "active" : ""} aria-current={n.id === page ? "page" : undefined} onClick={() => setPage(n.id)}>
                  <Icon name={n.icon} size={19} />
                  <span>{n.label}</span>
                  {"soon" in n && n.soon && <span className="soon">به‌زودی</span>}
                  {n.id === "inbox" && arrived > 0 && <span className="badge" aria-label={`${arrived} منتظر`}>{arrived}</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <nav aria-label="من">
          {nav.filter((n) => n.id === "settings").map((n) => (
            <button key={n.id} className={n.id === page ? "active" : ""} aria-current={n.id === page ? "page" : undefined} onClick={() => setPage(n.id)}>
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
        {page === "dashboard" && !history.length ? null : (
          <div className="back-row">
            <button className="btn ghost small" disabled={!history.length} onClick={back} title="Alt + ←">
              <Icon name="back" size={16} /> برگشت
            </button>
          </div>
        )}
        {page === "dashboard" ? (
          user!.role === "partner" || user!.sections?.includes("dashboard") ? <Dashboard go={goFromDashboard} /> : <Home />
        ) : (
          <>
            <h1>{member?.id === null ? "عضو جدید" : current.label}</h1>
            {page === "settings" ? <Settings />
              : page === "users" ? <Users />
              : page === "members" ? (
                <>
                  {member?.id && <MemberPage key={member.id} id={member.id} openBill={member.bill} onBack={back} onRemoved={() => { setListKey((k) => k + 1); back(); }} />}
                  {member && member.id === null && <NewMember onSaved={(id, bill) => openMember(id, bill)} onCancel={back} />}
                  {/* The list stays mounted under a member's page, so its search and place are kept. */}
                  <div hidden={!!member}>
                    <MembersList key={listKey} open={(id) => openMember(id)} add={() => go({ page: "members", member: { id: null } })} />
                  </div>
                </>
              )
              : page === "memberships" ? <Desk openMember={(id) => openMember(id)} newMember={() => go({ page: "members", member: { id: null } })} />
              : page === "registrations" ? <Registrations key={JSON.stringify(reg ?? {})} initial={reg} openMember={(id) => openMember(id)} />
              : page === "receipts" ? <Bills />
              : page === "expenses" ? <Money />
              : page === "prices" ? <Prices />
              : page === "books" ? <Books />
              : page === "hotspot" ? <Hotspot />
              : page === "backup" ? <Backup />
              : page === "device" ? <Device />
              : page === "audit" ? <Audit openMember={(id) => openMember(id)} />
              : page === "inbox" ? <Inbox openMember={(id) => openMember(id)} />
              : page === "import" ? <ImportExcel done={() => setPage("dashboard")} />
              : <p className="glass muted">این بخش در مرحله‌های بعدی ساخته می‌شود.</p>}
          </>
        )}
      </main>
    </div>
  );
}

/** The home screen of someone who was not given the dashboard (the education staff, for now). */
function Home() {
  const { user } = useAuth();
  const pec = user!.role === "pec_staff";
  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <p className="eyebrow">{pec ? "خدمات تحصیلی" : ROLE_LABEL[user!.role]}</p>
          <h1>سلام {user!.full_name}</h1>
        </div>
      </header>
      <p className="glass muted">
        {pec ? "صفحهٔ اول خدمات تحصیلی (پرونده‌ها، قراردادها و پرداخت‌ها) در مرحله‌های بعدی ساخته می‌شود."
          : "بخش‌های کار شما در فهرست کنار صفحه است."}
      </p>
    </div>
  );
}

/** How many photos and scans from phones wait at the desk, checked every 30 seconds. */
function useInboxCount(on: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const check = () => api.inboxCount().then((c) => live && setN(c), () => {});
    void check();
    const t = window.setInterval(check, 30_000);
    window.addEventListener("inbox-changed", check);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("inbox-changed", check); };
  }, [on]);
  return n;
}
