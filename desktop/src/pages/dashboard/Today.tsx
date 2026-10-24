import { api, ApiError } from "../../lib/api";
import { sampleDashboard } from "../../lib/sample";
import { useLoad } from "../../lib/useLoad";
import { fa, formatShort, windowFor } from "../../lib/solar";
import { Icon } from "../../components/Icon";
import { DaysLeft } from "../../components/DaysLeft";
import { Failed, Kpi, Loading } from "../../components/Stat";
import { CategoryBars } from "../../components/charts/CategoryBars";

export type Go = (page: "members" | "books") => void;

const VS = "نسبت به دیروز";

/** Today only: today's money, who has to renew, which books have to come back. */
export function TodayView({ go }: { go: Go }) {
  const { data, failed, retry } = useLoad(
    (signal) => api.dashboard({ ...windowFor("day"), period: "day" }, signal),
    [],
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
        <Kpi icon="plus" label="ثبت‌نام جدید امروز" value={k.new_members} unit="نفر" compare={[{ prev: k.new_members_prev, vs: VS }]} />
        <Kpi icon="fingerprint" label="حاضری امروز" value={k.attendance} unit="ورود" compare={[{ prev: k.attendance_prev, vs: VS }]} />
      </section>

      <section className="grid-3">
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
                <span className="att-main"><strong>{b.book_title}</strong> <span className="muted small">{b.member_name} · شمارهٔ {b.member_no}</span></span>
                <DaysLeft days={b.days_left} soon={2} />
              </li>
            ))}
            {!data.books_attention.length && <li className="muted">هیچ کتابی دیر نکرده.</li>}
          </ul>
          <button className="btn ghost see-all" onClick={() => go("books")}>
            مشاهدهٔ همه ({fa(data.books_overdue + data.books_due_soon)})
          </button>
        </div>

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
