import { useEffect, useState } from "react";
import { api, errorText, type Bill, type HotspotBuy, type HotspotCard, type HotspotCards, type HotspotSales } from "../lib/api";
import { fa, formatDay, iso, monthStart } from "../lib/solar";
import { amount, decimal, fa2 } from "../lib/numbers";
import { SolarDate } from "../components/SolarDate";
import { RemoveButton } from "../components/RemoveButton";
import { BillPreview } from "../components/BillSheet";
import { Icon } from "../components/Icon";
import { VoidBill } from "./Bills";

type Tab = "count" | "buy" | "stock";
type Span = "today" | "month" | "all";

const gb = (v: number) => `${fa2(v)}GB`;
const whole = (s: string) => s.replace(/\D/g, "").slice(0, 6);

function range(span: Span) {
  const today = iso(new Date());
  return span === "today" ? { from: today, to: today } : span === "month" ? { from: iso(monthStart()) } : {};
}

/**
 * Internet hotspot cards, as in the Excel hotspot sheet: supplier bills come in with cards
 * of each volume, and at the end of the day the desk counts how many were sold.
 */
export function Hotspot() {
  const [tab, setTab] = useState<Tab>("count");
  const [cards, setCards] = useState<HotspotCards | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const changed = () => setTick((t) => t + 1);
  useEffect(() => {
    const ctl = new AbortController();
    api.hotspotCards(ctl.signal).then(setCards).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [tick]);
  return (
    <div className="page">
      <div className="desk-tasks">
        <button className={tab === "count" ? "on" : ""} onClick={() => setTab("count")}><Icon name="check" size={20} /> شمارش فروش امروز</button>
        <button className={tab === "buy" ? "on" : ""} onClick={() => setTab("buy")}><Icon name="plus" size={20} /> خرید کارت</button>
        <button className={tab === "stock" ? "on" : ""} onClick={() => setTab("stock")}><Icon name="chart" size={20} /> موجودی و سود</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {cards && tab === "count" && <Count cards={cards} done={changed} />}
      {cards && tab === "buy" && <Buy cards={cards} done={changed} />}
      {cards && tab === "stock" && <Stock cards={cards} tick={tick} changed={changed} />}
    </div>
  );
}

/** One number box per card volume; inactive cards still show while some are in hand. */
function Counts({ cards, values, set, stock }: {
  cards: HotspotCard[]; values: Record<number, string>; set: (v: number, s: string) => void; stock: boolean;
}) {
  return (
    <div className="card-counts">
      {cards.filter((c) => c.active || c.in_hand > 0).map((c) => {
        const n = Number(values[c.volume_gb] || 0);
        const over = stock && n > c.in_hand;
        return (
          <label key={c.volume_gb} className={`card-count${over ? " over" : ""}`}>
            <strong dir="ltr">{gb(c.volume_gb)}</strong>
            <span className="muted small">{fa(c.price)} افغانی · موجود {fa(c.in_hand)}</span>
            <input dir="ltr" inputMode="numeric" value={values[c.volume_gb] ?? ""} onChange={(e) => set(c.volume_gb, whole(e.target.value))} aria-label={`تعداد ${gb(c.volume_gb)}`} />
          </label>
        );
      })}
    </div>
  );
}

function lines(values: Record<number, string>) {
  return Object.entries(values).map(([v, q]) => ({ volume_gb: Number(v), quantity: Number(q || 0) })).filter((l) => l.quantity > 0);
}

function Count({ cards, done }: { cards: HotspotCards; done: () => void }) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [bill, setBill] = useState<string | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const picked = lines(values);
  const byVolume = new Map(cards.cards.map((c) => [c.volume_gb, c]));
  const sales = picked.reduce((s, l) => s + l.quantity * (byVolume.get(l.volume_gb)?.price ?? 0), 0);
  const cost = picked.reduce((s, l) => s + l.quantity * l.volume_gb * cards.cost_per_gb, 0);
  const over = picked.some((l) => l.quantity > (byVolume.get(l.volume_gb)?.in_hand ?? 0));

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.createHotspotSale(picked);
      setValues({});
      setSaved(`ثبت شد: فروش ${fa(r.sales)}، سود ${fa(r.profit)} افغانی.`);
      setBill(null);
      setLast(r.receipt_id);
      done();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wide">
      <h2>شمارش فروش امروز</h2>
      <p className="muted">آخر روز بنویسید از هر کارت چند دانه فروخته شد. سود آن (قیمت فروش منهای قیمت خرید) درآمد «انترنت هاتسپات» امروز می‌شود.</p>
      <Counts cards={cards.cards} values={values} set={(v, s) => { setSaved(""); setValues((x) => ({ ...x, [v]: s })); }} stock />
      {picked.length > 0 && (
        <p className="period-sum">
          {fa(picked.reduce((s, l) => s + l.quantity, 0))} کارت · فروش <strong>{fa(sales)}</strong> · قیمت خرید {fa(cost)} · سود <strong>{fa(sales - cost)} افغانی</strong>
        </p>
      )}
      {over && <p className="form-error">از بعضی کارت‌ها بیشتر از موجودی نوشته شده.</p>}
      {saved && <p className="form-ok" role="status">{saved} {last && <button className="btn small ghost" onClick={() => setBill(last)}>نمایش بل</button>}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="actions"><button className="btn big" disabled={!picked.length || over || busy} onClick={() => void save()}>ثبت فروش امروز</button></div>
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
    </section>
  );
}

function Buy({ cards, done }: { cards: HotspotCards; done: () => void }) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [day, setDay] = useState(iso(new Date()));
  const [billNo, setBillNo] = useState("");
  const [billGb, setBillGb] = useState("");
  const [extra, setExtra] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const picked = lines(values);
  const total = picked.reduce((s, l) => s + l.quantity * l.volume_gb, 0);
  const cost = total * cards.cost_per_gb + amount(extra);
  const gap = billGb ? Math.round((amount(billGb) - total) * 100) / 100 : 0;

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.createHotspotBuy({
        purchased_on: day, supplier_bill_no: billNo, bill_gb: billGb ? amount(billGb) : null, extra_cost: amount(extra), note, lines: picked,
      });
      setValues({});
      setBillNo("");
      setBillGb("");
      setExtra("");
      setNote("");
      setSaved(`بل خرید ثبت شد: ${fa(total)} GB، ${fa(cost)} افغانی.`);
      done();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wide">
      <h2>خرید کارت (بل فروشنده)</h2>
      <p className="muted">هر بل فروشنده یک بار. کارت‌هایی را که پیش از برنامه خریده شده و هنوز موجود است هم یک بار همین‌جا ثبت کنید.</p>
      <div className="form-grid">
        <SolarDate label="تاریخ" value={day} onChange={setDay} />
        <label className="field wide"><span>شمارهٔ بل</span><input value={billNo} onChange={(e) => setBillNo(e.target.value)} /></label>
        <label className="field wide"><span>حجم عمومی بل (GB)</span><input dir="ltr" inputMode="numeric" value={billGb} onChange={(e) => setBillGb(decimal(e.target.value))} /></label>
        <label className="field wide"><span>مصارف (افغانی)</span><input dir="ltr" inputMode="numeric" value={extra} onChange={(e) => setExtra(decimal(e.target.value))} /></label>
      </div>
      <Counts cards={cards.cards} values={values} set={(v, s) => { setSaved(""); setValues((x) => ({ ...x, [v]: s })); }} stock={false} />
      <label className="field wide"><span>ملاحظات</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {picked.length > 0 && (
        <p className="period-sum">
          {fa(picked.reduce((s, l) => s + l.quantity, 0))} کارت · {fa2(total)} GB · مبلغ خرید <strong>{fa(cost)} افغانی</strong>
          {billGb && (gap === 0 ? " · با بل می‌خواند" : <span className="form-error inline"> · تفاوت با بل: {fa2(gap)} GB</span>)}
        </p>
      )}
      {saved && <p className="form-ok" role="status">{saved}</p>}
      {error && <p className="form-error">{error}</p>}
      <div className="actions"><button className="btn big" disabled={!picked.length || !day || busy} onClick={() => void save()}>ثبت بل خرید</button></div>
    </section>
  );
}

function Stock({ cards, tick, changed }: { cards: HotspotCards; tick: number; changed: () => void }) {
  const [span, setSpan] = useState<Span>("month");
  const [sales, setSales] = useState<HotspotSales | null>(null);
  const [buys, setBuys] = useState<HotspotBuy[] | null>(null);
  const [error, setError] = useState("");
  const [voiding, setVoiding] = useState<Bill | null>(null);
  const [show, setShow] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    const r = range(span);
    Promise.all([api.hotspotSales(r, ctl.signal), api.hotspotBuys(r, ctl.signal)])
      .then(([s, b]) => { setSales(s); setBuys(b); setError(""); })
      .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [span, tick]);

  async function removeBuy(id: string) {
    try { await api.deleteHotspotBuy(id); changed(); } catch (e) { setError(errorText(e)); }
  }
  async function askVoid(id: string) {
    try { setVoiding(await api.bill(id)); } catch (e) { setError(errorText(e)); }
  }

  const s = sales?.summary;
  return (
    <>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>کارت</th><th>قیمت فروش</th><th>خریده‌شده</th><th>فروخته‌شده</th><th>موجود</th></tr></thead>
          <tbody>
            {cards.cards.filter((c) => c.active || c.bought > 0).map((c) => (
              <tr key={c.volume_gb} className={c.active ? "" : "inactive"}>
                <td><strong dir="ltr">{gb(c.volume_gb)}</strong></td>
                <td className="num">{fa(c.price)}</td>
                <td className="num">{fa(c.bought)}</td>
                <td className="num">{fa(c.sold)}</td>
                <td className="num"><span className={c.in_hand > 0 ? "days ok" : "days none"}>{fa(c.in_hand)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="list-tools">
        <div className="segmented" role="tablist" aria-label="دوره">
          {([["today", "امروز"], ["month", "این ماه"], ["all", "همه"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={span === id} className={span === id ? "on" : ""} onClick={() => setSpan(id)}>{label}</button>
          ))}
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {s && (
        <div className="kpis hotspot-kpis">
          <div className="glass kpi hero"><span className="kpi-label">سود (درآمد هاتسپات)</span><span className="kpi-value">{fa(s.profit)} <small>افغانی</small></span></div>
          <div className="glass kpi"><span className="kpi-label">فروش</span><span className="kpi-value">{fa(s.sales)}</span><span className="muted small">{fa(s.cards_sold)} کارت · {fa2(s.gb_sold)} GB</span></div>
          <div className="glass kpi"><span className="kpi-label">قیمت خرید کارت‌های فروخته</span><span className="kpi-value">{fa(s.cost)}</span></div>
          <div className="glass kpi"><span className="kpi-label">بل‌های خرید</span><span className="kpi-value">{fa(s.bought)}</span></div>
        </div>
      )}
      <h2>شمارش‌های فروش</h2>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>شمارهٔ بل</th><th>کارت‌ها</th><th>فروش</th><th>سود</th><th>ثبت کننده</th><th /></tr></thead>
          <tbody>
            {sales?.rows.map((r) => (
              <tr key={r.receipt_id} className={r.voided ? "inactive" : ""}>
                <td>{formatDay(r.sold_on)}</td>
                <td><bdi dir="ltr">{r.receipt_no}</bdi></td>
                <td dir="rtl">{r.cards}</td>
                <td className="num">{fa(r.sales)}</td>
                <td className="num">{fa(r.profit)}</td>
                <td className="muted">{r.created_by ?? "—"}</td>
                <td><div className="row-actions">
                  {r.voided ? <span className="status off">باطل</span> : (
                    <>
                      <button className="btn small ghost" onClick={() => setShow(r.receipt_id)}>بل</button>
                      <button className="btn small ghost danger" onClick={() => void askVoid(r.receipt_id)}>باطل کردن</button>
                    </>
                  )}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {sales && !sales.rows.length && <p className="muted empty">فروشی ثبت نشده.</p>}
      </div>
      <h2>بل‌های خرید</h2>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>شمارهٔ بل</th><th>کارت‌ها</th><th>GB</th><th>مبلغ خرید</th><th>ثبت کننده</th><th /></tr></thead>
          <tbody>
            {buys?.map((b) => (
              <tr key={b.id}>
                <td>{formatDay(b.purchased_on)}</td>
                <td>{b.supplier_bill_no ?? "—"}</td>
                <td dir="rtl">{b.cards}{b.note && <div className="muted small">{b.note}</div>}</td>
                <td className="num">{fa2(b.gb)}{b.bill_gb !== null && Math.abs(b.bill_gb - b.gb) >= 0.005 && <div className="form-error inline small">بل: {fa2(b.bill_gb)}</div>}</td>
                <td className="num">{fa(b.cost)}</td>
                <td className="muted">{b.created_by ?? "—"}</td>
                <td>{b.removable && <RemoveButton onConfirm={() => void removeBuy(b.id)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {buys && !buys.length && <p className="muted empty">بل خریدی ثبت نشده.</p>}
      </div>
      {show && <BillPreview id={show} onClose={() => setShow(null)} />}
      {voiding && (
        <VoidBill bill={voiding} note="کارت‌های این شمارش به موجودی برمی‌گردد." onClose={(ok) => { setVoiding(null); if (ok) changed(); }} />
      )}
    </>
  );
}
