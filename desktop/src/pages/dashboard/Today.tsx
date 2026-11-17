import { useEffect, useState } from "react";
import { api, ApiError, type Expense, type LateDebts, type RegKind, type RegSummary, type Registration } from "../../lib/api";
import { sampleDashboard } from "../../lib/sample";
import { useLoad } from "../../lib/useLoad";
import { fa, formatShort, iso, windowFor } from "../../lib/solar";
import { kindLabel } from "../Registrations";
import { Icon } from "../../components/Icon";
import { DaysLeft } from "../../components/DaysLeft";
import { Failed, Kpi, Loading } from "../../components/Stat";
import { CategoryBars } from "../../components/charts/CategoryBars";

export type Go = (page: "members" | "books" | "registrations" | "expenses", kind?: RegKind) => void;

const VS = "نسبت به دیروز";

/** Today only: today's money, who has to renew, which books have to come back. */
export function TodayView({ go, openMember }: { go: Go; openMember: (id: string) => void }) {
  // Today's numbers change all day (punches, bills): read again every minute and whenever
  // the window comes back to the front, so a dashboard left open is never hours behind.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const timer = window.setInterval(() => { if (!document.hidden) again(); }, 60_000);
    window.addEventListener("focus", again);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", again); };
  }, []);
  const { data, failed, retry } = useLoad(
    (signal) => api.dashboard({ ...windowFor("day"), period: "day" }, signal),
    [tick],
    // Sample numbers only while developing the screen; real users never see invented figures.
    (e) => (import.meta.env.DEV && !(e instanceof ApiError) ? sampleDashboard("day") : null),
  );
  if (failed) return <Failed retry={retry} />;
  if (!data) return <Loading />;
  const k = data.kpis;

  return (
    <>
      <section className="kpis three">
        <Kpi hero icon="wallet" label="درآمد امروز" value={k.income} unit="؋" compare={[{ prev: k.income_prev, vs: VS }]} />
        <Kpi icon="receipt" label="مصارف امروز" value={k.expenses} unit="؋" upIsGood={false} compare={[{ prev: k.expenses_prev, vs: VS }]} />
        <Kpi icon="chart" label="سود خالص امروز" value={k.income - k.expenses} unit="؋" compare={[{ prev: k.income_prev - k.expenses_prev, vs: VS }]} />
      </section>
      <section className="kpis three">
        <Kpi icon="users" label="اعضای فعال امروز" value={k.active_members} unit="نفر" compare={[{ prev: k.active_members_prev, vs: VS }]} />
        <Kpi icon="plus" label="ثبت‌نام امروز (جدید و روزانه)" value={k.new_members} unit="نفر" compare={[{ prev: k.new_members_prev, vs: VS }]} />
        <Kpi icon="fingerprint" label="حاضری امروز" value={k.attendance} unit="نفر" compare={[{ prev: k.attendance_prev, vs: VS }]}
          note={<PunchesFresh at={k.punches_newest ?? null} read={k.punches_read_at ?? null} />} />
      </section>

      <section className="grid-3 today-grid">
        <TodaySignups go={go} />

        <div className="glass">
          <div className="panel-head">
            <h2>عضویت‌های نزدیک به ختم</h2>
            <span className="muted small">{fa(data.members_due_soon)} تا 5 روز · {fa(data.members_expired)} تمام‌شده</span>
          </div>
          <ul className="attention">
            {data.members_attention.map((m) => (
              <li key={m.member_no} className={m.days_left < 0 ? "late" : ""}>
                <span className="att-icon"><Icon name="clock" size={18} /></span>
                <span className="att-main"><strong>{m.name}</strong> <span className="muted small">شمارهٔ {m.member_no} · ختم {formatShort(m.end_date)}</span></span>
                <DaysLeft days={m.days_left} />
              </li>
            ))}
            {!data.members_attention.length && <li className="muted">عضویتی در 5 روز آینده ختم نمی‌شود.</li>}
          </ul>
          <button className="btn ghost see-all" onClick={() => go("members")}>
            مشاهدهٔ همه ({fa(data.members_due_soon + data.members_expired)})
          </button>
        </div>

        <div className="glass">
          <div className="panel-head">
            <h2>کتاب‌های امانتی</h2>
            <span className="muted small">{fa(data.books_overdue)} دیرکرده · {fa(data.books_due_soon)} تا 2 روز</span>
          </div>
          <ul className="attention">
            {data.books_attention.map((b, i) => (
              <li key={i} className={b.days_left < 0 ? "late" : ""}>
                <span className="att-icon"><Icon name="book" size={18} /></span>
                <span className="att-main"><strong>{b.book_title}</strong> <span className="muted small">{b.member_name} · <bdi dir="ltr">{b.card_no}</bdi></span></span>
                <DaysLeft days={b.days_left} soon={2} />
              </li>
            ))}
            {!data.books_attention.length && <li className="muted">هیچ کتابی دیر نکرده.</li>}
          </ul>
          <button className="btn ghost see-all" onClick={() => go("books")}>
            مشاهدهٔ همه ({fa(data.books_overdue + data.books_due_soon)})
          </button>
        </div>

        <LateDebtsPanel openMember={openMember} tick={tick} />

        <TodayExpenses go={go} />

        <div className="glass">
          <div className="panel-head">
            <h2>درآمد امروز به تفکیک بخش</h2>
          </div>
          <CategoryBars data={data.income_by_category} empty="امروز هنوز درآمدی ثبت نشده." />
        </div>
      </section>
    </>
  );
}

/**
 * What today's expenses figure is made of: each line with what it was for, the newest first,
 * in a list that scrolls; «مشاهدهٔ همه» opens the expenses page. Hidden for someone who may
 * not see expenses.
 */
function TodayExpenses({ go }: { go: Go }) {
  const [lines, setLines] = useState<{ rows: Expense[]; sum: number; total: number } | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    const today = iso(new Date());
    api.expenses({ from: today, to: today }, ctl.signal)
      .then(setLines)
      .catch(() => { if (!ctl.signal.aborted) setHidden(true); });
    return () => ctl.abort();
  }, []);
  if (hidden) return null;
  return (
    <div className="glass">
      <div className="panel-head">
        <h2>مصارف امروز</h2>
        {lines && <span className="muted small">{fa(lines.total)} قلم · {fa(lines.sum)} ؋</span>}
      </div>
      <ul className="attention scroll">
        {lines?.rows.map((e) => (
          <li key={e.id}>
            <span className="att-icon"><Icon name="receipt" size={18} /></span>
            <span className="att-main"><strong>{e.category}</strong>{e.description && <span className="muted small"> · {e.description}</span>}</span>
            <span className="exp-amount">{fa(e.amount)} ؋</span>
          </li>
        ))}
        {lines && !lines.rows.length && <li className="muted">امروز هنوز مصرفی ثبت نشده.</li>}
      </ul>
      <button className="btn ghost see-all" onClick={() => go("expenses")}>مشاهدهٔ همهٔ مصارف</button>
    </div>
  );
}

/**
 * Members who have owed money for a week or more, the longest first: who to call or put on
 * hold. A row opens the member's page (pay the rest, or «تعلیق»). Hidden for whoever may not
 * see the hall, and when no one is late.
 */
function LateDebtsPanel({ openMember, tick }: { openMember: (id: string) => void; tick: number }) {
  const [late, setLate] = useState<LateDebts | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    api.lateDebts(ctl.signal).then(setLate).catch(() => {});
    return () => ctl.abort();
  }, [tick]);
  if (!late || !late.count) return null;
  return (
    <div className="glass">
      <div className="panel-head">
        <h2><Icon name="alert" size={18} /> باقی‌های بیش از یک هفته</h2>
        <span className="muted small">{fa(late.count)} عضو · {fa(late.sum)} ؋</span>
      </div>
      <ul className="attention scroll">
        {late.rows.map((r) => (
          <li key={r.member_id}>
            <button type="button" className="att-row" onClick={() => openMember(r.member_id)}>
              <span className="att-main"><strong>{r.name}</strong> <span className="muted small">آیدی {r.member_no} · {fa(r.days)} روز</span></span>
              {r.paused ? <span className="chip">تعلیق</span> : <span className="exp-amount owed">{fa(r.owed)} ؋</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const clock = (at: string) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kabul" });

/**
 * How fresh «حاضری امروز» is: the newest punch read from the device, and on the computer the
 * device is on, a warning when it has not been read for a while (out of reach, ZKAccess
 * open), so a low number in the morning is not taken for an empty hall.
 */
function PunchesFresh({ at, read }: { at: string | null; read: string | null }) {
  const behind = read !== null && Date.now() - new Date(read).getTime() > 20 * 60_000;
  if (behind) return <span className="warn-text">دستگاه از ساعت <bdi dir="ltr">{clock(read)}</bdi> خوانده نشده؛ ورودهای بعد از آن هنوز شمرده نشده‌اند.</span>;
  if (!at || iso(new Date(at)) !== iso(new Date())) return <>امروز هنوز ورودی از دستگاه نیامده.</>;
  return <>آخرین ورود: ساعت <bdi dir="ltr">{clock(at)}</bdi></>;
}

/** Today's sign-ups (daily seats, new and renewed members), with the way to all of them. */
function TodaySignups({ go }: { go: Go }) {
  const [rows, setRows] = useState<Registration[] | null>(null);
  const [sum, setSum] = useState<RegSummary | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const today = iso(new Date());
    api.registrations({ from: today, to: today, limit: 8 }, ctl.signal)
      .then((p) => { setRows(p.rows); setSum(p.summary); })
      .catch(() => { if (!ctl.signal.aborted) setRows([]); });
    return () => ctl.abort();
  }, []);
  return (
    <div className="glass">
      <div className="panel-head">
        <h2>ثبت‌نام‌های امروز</h2>
        {sum && <span className="muted small">{fa(sum.daily)} روزانه · {fa(sum.monthly_new)} جدید · {fa(sum.monthly_renewed)} تمدید</span>}
      </div>
      <ul className="attention">
        {rows?.map((r) => (
          <li key={r.id}>
            <span className="att-icon"><Icon name={r.kind === "daily" ? "clock" : "users"} size={18} /></span>
            <span className="att-main"><strong>{r.name}</strong> <span className="muted small">{r.member_no ? `آیدی ${r.member_no} · ` : ""}{r.plan_name}</span></span>
            <span className={`chip kind-${r.kind}${r.kind === "monthly" && r.first ? " new" : ""}`}>{kindLabel(r)}</span>
          </li>
        ))}
        {rows && !rows.length && <li className="muted">امروز هنوز کسی ثبت‌نام نکرده.</li>}
      </ul>
      <div className="see-all-row">
        <button className="btn ghost see-all" onClick={() => go("registrations", "daily")}>عضویت‌های روزانه ({fa(sum?.daily ?? 0)})</button>
        <button className="btn ghost see-all" onClick={() => go("registrations", "monthly")}>عضویت‌های ماهانه ({fa((sum?.monthly_new ?? 0) + (sum?.monthly_renewed ?? 0))})</button>
      </div>
    </div>
  );
}
