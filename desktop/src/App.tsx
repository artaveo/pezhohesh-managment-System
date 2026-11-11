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
import { Attendance } from "./pages/Attendance";
import { DeviceUsers } from "./pages/DeviceUsers";
import { Money } from "./pages/Money";
import { Prices } from "./pages/Prices";
import { Audit } from "./pages/Audit";
import { FirstSetup, ForcePasswordChange, Login } from "./pages/Login";
import { Offline } from "./pages/Offline";
import { Icon } from "./components/Icon";
import { useAuth } from "./auth/AuthProvider";
import { useTheme } from "./theme/ThemeProvider";
import { api, ROLE_LABEL, type DebtGroup, type Section, type User } from "./lib/api";
import { DebtPage } from "./pages/Debts";
import { Inbox } from "./pages/Inbox";
import { SyncChip } from "./components/SyncChip";
import { Reports } from "./pages/Reports";
import { Tabs } from "./components/Tabs";
import { Notes } from "./pages/Notes";
import { SearchPalette, type SearchPage } from "./components/SearchPalette";
import { useFileSending } from "./lib/images";

/**
 * The menu. A section with `section` is shown to the roles a partner gave it to on the users
 * page (partners see all); `partner` sections are for partners only. The API checks the
 * same thing; hiding a section here only keeps the menu tidy. Grouped by department (the
 * hall, its money, the education department) and then running the system, most used first.
 * Pages with a `hub` share one menu item and are tabs inside it, so the menu stays short.
 */
type Hub = "members" | "device";
type NavItem = { id: string; icon: string; label: string; group: string; hub?: Hub; section?: Section; also?: readonly Section[]; partner?: true; soon?: true };
export const NAV = [
  { id: "dashboard", icon: "home", label: "داشبورد", group: "" },
  { id: "memberships", icon: "card", label: "پذیرش و تمدید", section: "memberships", group: "قرائت‌خانه", hub: "members" },
  { id: "members", icon: "users", label: "فهرست اعضا", section: "members", group: "قرائت‌خانه", hub: "members" },
  { id: "registrations", icon: "userPlus", label: "ثبت‌نام‌ها", section: "registrations", group: "قرائت‌خانه", hub: "members" },
  { id: "attendance", icon: "calendar", label: "حاضری روزانه", section: "members", group: "قرائت‌خانه", hub: "members" },
  { id: "inbox", icon: "phone", label: "رسیده از موبایل", section: "inbox", group: "قرائت‌خانه", hub: "members" },
  { id: "books", icon: "book", label: "امانت کتاب", section: "books", group: "قرائت‌خانه" },
  { id: "hotspot", icon: "wifi", label: "کارت هاتسپات", section: "hotspot", group: "قرائت‌خانه" },
  { id: "receipts", icon: "receipt", label: "بل‌ها", section: "receipts", group: "حساب و پول" },
  // Staff salaries and the partners' shares live inside it, under «برداشت‌ها»; «عواید
  // متفرقه» and «طلبات» under «عواید».
  { id: "expenses", icon: "wallet", label: "مصارف و برداشت‌ها", section: "expenses", also: ["salaries", "shares", "receipts"], group: "حساب و پول" },
  { id: "reports", icon: "chart", label: "گزارش مالی", section: "reports", group: "حساب و پول" },
  { id: "notes", icon: "note", label: "یادداشت‌ها", partner: true, group: "حساب و پول" },
  { id: "pec", icon: "cap", label: "خدمات تحصیلی", section: "pec", group: "خدمات تحصیلی", soon: true },
  { id: "import", icon: "upload", label: "ورود از اکسل", section: "import", group: "مدیریت" },
  { id: "device", icon: "fingerprint", label: "وضعیت و تنظیم", section: "device", group: "مدیریت", hub: "device" },
  { id: "deviceUsers", icon: "users", label: "کاربران دستگاه", section: "device", group: "مدیریت", hub: "device" },
  { id: "backup", icon: "database", label: "پشتیبان", section: "backup", group: "مدیریت" },
  { id: "prices", icon: "tag", label: "قیمت‌ها", section: "prices", group: "مدیریت" },
  { id: "users", icon: "shield", label: "کاربران", section: "users", group: "مدیریت" },
  { id: "audit", icon: "history", label: "چه کسی چه کرد", section: "audit", group: "مدیریت" },
  { id: "settings", icon: "user", label: "تنظیمات من", group: "" },
] as const satisfies readonly NavItem[];

/** The one menu item of a hub, and the title over its tabs. */
const HUB: Record<Hub, { icon: string; label: string }> = {
  members: { icon: "users", label: "اعضا" },
  device: { icon: "fingerprint", label: "دستگاه انگشت" },
};
const hubOf = (n: object): Hub | undefined => ("hub" in n ? (n.hub as Hub) : undefined);

/** Other words a section is looked for by in the search (what is inside it, common names). */
const SEARCH_WORDS: Record<string, string> = {
  dashboard: "خانه گزارش امروز درآمد امروز",
  memberships: "تمدید پذیرش عضو جدید عضویت روزانه بل کارت اسکن",
  members: "عضو شاگرد فهرست باقی بدهی",
  registrations: "ثبت نام جدید",
  attendance: "حاضری ورود خروج",
  inbox: "عکس تذکره موبایل گوشی",
  books: "کتاب امانت ضمانت فهرست کتاب‌ها",
  hotspot: "انترنت کارت هاتسپات wifi",
  receipts: "بل رسید باطل",
  expenses: "مصرف خرج برداشت معاش کارمند شرکا سهم عواید متفرقه طلبات",
  reports: "گزارش مالی ماهانه سالانه موجودی صندوق",
  notes: "یادداشت حساب قرض",
  import: "اکسل excel ورود",
  device: "اثر انگشت k50 دستگاه zk",
  deviceUsers: "کاربران دستگاه اثر انگشت",
  backup: "پشتیبان بکاپ سرور فایل",
  prices: "قیمت پلان تعرفه",
  users: "کاربر رمز دسترسی مدیر",
  audit: "تاریخچه لاگ چه کسی",
  settings: "رنگ تم رمز من",
};

/** Whether this person sees a menu item. */
function sees(user: User, n: NavItem) {
  if (user.role === "partner") return true;
  if (n.partner) return false;
  return !n.section || [n.section, ...(n.also ?? [])].some((s) => (user.sections ?? []).includes(s));
}

type PageId = (typeof NAV)[number]["id"];
/** Where the app is: a page, and inside "members" one member or the new-member form. */
type View = { page: PageId; member: { id: string | null; bill?: string | null; fresh?: boolean; debts?: boolean } | null; reg?: RegFilter; debt?: DebtGroup };

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
  useFileSending(nav.some((n) => n.id === "members"));
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
  const setPage = (id: PageId) => { if (id !== page || member || view.debt) go({ page: id, member: null }); };
  const goFromDashboard = (id: "members" | "books" | "registrations", kind?: RegKind) =>
    go({ page: id, member: null, reg: id === "registrations" ? { span: "today", kind } : undefined });
  const openMember = (id: string, bill: string | null = null, fresh = false) => go({ page: "members", member: { id, bill, fresh } });
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
  const hub = hubOf(current);
  // The tab last open in each hub, so the menu item brings you back where you were.
  const [lastTab, setLastTab] = useState<Partial<Record<Hub, PageId>>>({});
  useEffect(() => { if (hub) setLastTab((t) => (t[hub] === page ? t : { ...t, [hub]: page })); }, [hub, page]);
  const openHub = (h: Hub) => {
    const tabs = nav.filter((n) => hubOf(n) === h);
    const to = tabs.find((n) => n.id === lastTab[h]) ?? tabs[0];
    if (to) setPage(to.id);
  };
  // One entry per hub: the first page of a hub stands for it in the menu.
  const main = nav.filter((n) => n.id !== "settings" && (!hubOf(n) || nav.find((x) => hubOf(x) === hubOf(n)) === n));
  const groups = [...new Set(main.map((n) => n.group))];
  const hubTabs = hub ? nav.filter((n) => hubOf(n) === hub) : [];
  // The search window (Ctrl+K): every page this person may open, and the members.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.code === "KeyK")) { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const searchPages: SearchPage[] = nav.filter((n) => !("soon" in n && n.soon)).map((n) => {
    const h = hubOf(n);
    return { id: n.id, label: n.label, where: h ? HUB[h].label : n.group || undefined, icon: n.icon, keywords: SEARCH_WORDS[n.id] };
  });

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
        <button className="side-search" onClick={() => setSearching(true)} aria-keyshortcuts="Control+K">
          <Icon name="search" size={17} />
          <span>جستجو</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav aria-label="بخش‌ها">
          {groups.map((g) => (
            <div key={g || "top"} role="group" aria-label={g || "داشبورد"}>
              {/* A group of one item named as the item itself needs no heading of its own. */}
              {g && !(main.filter((n) => n.group === g).length === 1 && main.find((n) => n.group === g)?.label === g) && <div className="nav-group">{g}</div>}
              {main.filter((n) => n.group === g).map((n) => {
                const h = hubOf(n);
                const on = h ? h === hub : n.id === page;
                const waiting = h === "members" && nav.some((x) => x.id === "inbox") ? arrived : 0;
                return (
                  <button key={n.id} className={on ? "active" : ""} aria-current={on ? "page" : undefined} onClick={() => (h ? openHub(h) : setPage(n.id))}>
                    <Icon name={h ? HUB[h].icon : n.icon} size={19} />
                    <span>{h ? HUB[h].label : n.label}</span>
                    {"soon" in n && n.soon && <span className="soon">به‌زودی</span>}
                    {waiting > 0 && <span className="badge" aria-label={`${waiting} عکس از موبایل منتظر`}>{waiting}</span>}
                  </button>
                );
              })}
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
        <SyncChip onOpen={nav.some((n) => n.id === "backup") ? () => setPage("backup") : undefined} />
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
      {searching && (
        <SearchPalette pages={searchPages} members={nav.some((n) => n.id === "members")}
          onPage={(id) => setPage(id as PageId)} onMember={(id) => openMember(id)} onClose={() => setSearching(false)} />
      )}
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
            <h1>{member?.id === null ? "عضو جدید" : member?.debts || view.debt ? "باقی‌ها" : hub ? HUB[hub].label : current.label}</h1>
            {hub && !member && !view.debt && hubTabs.length > 1 && (
              <div className="hub-tabs">
                <Tabs label={HUB[hub].label} value={page as string} onChange={(id) => setPage(id as PageId)}
                  items={hubTabs.map((n) => ({ id: n.id as string, label: n.label, badge: n.id === "inbox" ? arrived : 0 }))} />
              </div>
            )}
            {page === "settings" ? <Settings />
              : page === "users" ? <Users />
              : page === "members" ? (
                <>
                  {member?.id && <MemberPage key={`${member.id}-${member.debts ? "d" : ""}`} id={member.id} openBill={member.bill} fresh={member.fresh} debts={member.debts}
                    openDebts={() => go({ page: "members", member: { id: member.id, debts: true } })} onBack={back} onRemoved={() => { setListKey((k) => k + 1); back(); }} />}
                  {!member && view.debt && <DebtPage key={view.debt.key} group={view.debt} />}
                  {member && member.id === null && <NewMember onSaved={(id, bill) => openMember(id, bill, true)} onCancel={back} />}
                  {/* The list stays mounted under a member's page, so its search and place are kept. */}
                  <div hidden={!!member || !!view.debt}>
                    <MembersList key={listKey} open={(id) => openMember(id)} add={() => go({ page: "members", member: { id: null } })}
                      openDebts={(g) => go(g.member_id ? { page: "members", member: { id: g.member_id, debts: true } } : { page: "members", member: null, debt: g })} />
                  </div>
                </>
              )
              : page === "memberships" ? <Desk openMember={(id) => openMember(id)} newMember={() => go({ page: "members", member: { id: null } })} />
              : page === "registrations" ? <Registrations key={JSON.stringify(reg ?? {})} initial={reg} openMember={(id) => openMember(id)} />
              : page === "receipts" ? <Bills />
              : page === "attendance" ? <Attendance openMember={(id) => openMember(id)} />
              : page === "reports" ? <Reports />
              : page === "notes" ? <Notes />
              : page === "expenses" ? <Money />
              : page === "prices" ? <Prices />
              : page === "books" ? <Books />
              : page === "hotspot" ? <Hotspot />
              : page === "backup" ? <Backup />
              : page === "device" ? <Device />
              : page === "deviceUsers" ? <DeviceUsers openMember={(id) => openMember(id)} />
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
