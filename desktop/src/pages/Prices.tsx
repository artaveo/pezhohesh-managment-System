import { useEffect, useState } from "react";
import { api, errorText, type BookRules, type Plan, type PlanKind } from "../lib/api";
import { amount, decimal, fa2 } from "../lib/numbers";

const KINDS: { id: PlanKind; label: string; days: number }[] = [
  { id: "monthly", label: "ماهانه", days: 30 },
  { id: "internet", label: "انترنت", days: 30 },
  { id: "daily", label: "روزانه", days: 1 },
];

type Draft = Omit<Plan, "id"> & { id: string | null };

/** The price list (partners only). A new price applies to new bills; old bills keep theirs. */
export function Prices() {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = () => api.plans().then(setRows).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);

  const edit = (i: number, patch: Partial<Draft>) => setRows((r) => r && r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save(d: Draft) {
    setError("");
    setSaved("");
    try {
      const body = { kind: d.kind, name: d.name, price: Number(d.price), duration_days: Number(d.duration_days), active: d.active, sort_order: d.sort_order };
      if (d.id) await api.updatePlan(d.id, body);
      else await api.createPlan(body);
      setSaved(`«${d.name}» ذخیره شد.`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="page">
      <p className="muted">قیمت تازه از بل بعدی حساب می‌شود؛ بل‌های قبلی همان مبلغ خودشان را نگه می‌دارند. نوعی را که دیگر نمی‌فروشید غیرفعال کنید، پاک نکنید.</p>
      {saved && <p className="form-ok" role="status">{saved}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table prices">
          <thead><tr><th>نام</th><th>دسته</th><th>قیمت (افغانی)</th><th>مدت (روز)</th><th>فعال</th><th /></tr></thead>
          <tbody>
            {rows?.map((p, i) => (
              <tr key={p.id ?? `new-${i}`} className={p.active ? "" : "inactive"}>
                <td><input value={p.name} onChange={(e) => edit(i, { name: e.target.value })} /></td>
                <td>
                  <select value={p.kind} onChange={(e) => edit(i, { kind: e.target.value as PlanKind })}>
                    {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                  </select>
                </td>
                <td><input dir="ltr" inputMode="numeric" value={p.price} onChange={(e) => edit(i, { price: Number(e.target.value.replace(/[^\d.]/g, "")) })} /></td>
                <td><input dir="ltr" inputMode="numeric" value={p.duration_days} onChange={(e) => edit(i, { duration_days: Number(e.target.value.replace(/\D/g, "")) })} /></td>
                <td><input type="checkbox" checked={p.active} onChange={(e) => edit(i, { active: e.target.checked })} aria-label="فعال" /></td>
                <td><button className="btn small" disabled={!p.name.trim() || !(p.duration_days > 0)} onClick={() => void save(p)}>ذخیره</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={() => setRows((r) => [...(r ?? []), { id: null, kind: "monthly", name: "", price: 0, duration_days: 30, active: true, sort_order: (r?.length ?? 0) + 1 }])}>
          + نوع تازه
        </button>
      </div>
      <LendingRules />
      <HotspotPrices />
    </div>
  );
}

/** How long a book may stay out, its weekly fee, and the fine for each late day. */
function LendingRules() {
  // Kept as typed (text) so a decimal point can be typed.
  const [r, setR] = useState<Record<keyof BookRules, string> | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.bookRules().then((b) => setR({ loan_days: String(b.loan_days), weekly_fee: String(b.weekly_fee), fine_per_day: String(b.fine_per_day) }))
      .catch((e) => setError(errorText(e)));
  }, []);
  if (!r) return error ? <p className="form-error">{error}</p> : null;
  const set = (k: keyof BookRules, v: string) => { setSaved(false); setR({ ...r, [k]: k === "loan_days" ? v.replace(/\D/g, "") : decimal(v) }); };
  async function save() {
    setError("");
    try {
      await api.setBookRules({ loan_days: amount(r!.loan_days), weekly_fee: amount(r!.weekly_fee), fine_per_day: amount(r!.fine_per_day) });
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="panel wide">
      <h2>امانت کتاب</h2>
      <p className="muted">برای امانت‌های تازه حساب می‌شود. فیس و جریمه هنگام برگشت کتاب گرفته می‌شود و می‌شود آن را همان‌جا تغییر داد.</p>
      <div className="form-grid">
        <label className="field wide"><span>مدت امانت (روز)</span><input dir="ltr" inputMode="numeric" value={r.loan_days} onChange={(e) => set("loan_days", e.target.value)} /></label>
        <label className="field wide"><span>فیس هر هفته (افغانی)</span><input dir="ltr" inputMode="decimal" value={r.weekly_fee} onChange={(e) => set("weekly_fee", e.target.value)} /></label>
        <label className="field wide"><span>جریمهٔ هر روز دیرکرد (افغانی)</span><input dir="ltr" inputMode="decimal" value={r.fine_per_day} onChange={(e) => set("fine_per_day", e.target.value)} /></label>
      </div>
      {saved && <p className="form-ok" role="status">ذخیره شد.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions"><button className="btn" disabled={!(amount(r.loan_days) > 0)} onClick={() => void save()}>ذخیره</button></div>
    </section>
  );
}

type CardDraft = { volume_gb: number; price: string; active: boolean };

/** Sale price of each hotspot card, and what one GB costs from the supplier. */
function HotspotPrices() {
  const [cost, setCost] = useState<string | null>(null);
  const [cards, setCards] = useState<CardDraft[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api.hotspotCards().then((p) => {
      setCost(String(p.cost_per_gb));
      setCards(p.cards.map((c) => ({ volume_gb: c.volume_gb, price: String(c.price), active: c.active })));
    }).catch((e) => setError(errorText(e)));
  }, []);
  if (cost === null) return error ? <p className="form-error">{error}</p> : null;
  const edit = (i: number, patch: Partial<CardDraft>) => { setSaved(false); setCards((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c))); };
  async function save() {
    setError("");
    try {
      await api.setHotspotCards({ cost_per_gb: amount(cost!), cards: cards.map((c) => ({ volume_gb: c.volume_gb, price: amount(c.price), active: c.active })) });
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="panel wide">
      <h2>کارت هاتسپات</h2>
      <p className="muted">قیمت فروش هر کارت. سود هر کارت = قیمت فروش منهای قیمت خریدش (حجم × قیمت خرید هر GB).</p>
      <label className="field"><span>قیمت خرید هر GB (افغانی)</span>
        <input dir="ltr" inputMode="decimal" value={cost} onChange={(e) => { setSaved(false); setCost(decimal(e.target.value)); }} />
      </label>
      <div className="glass table-wrap">
        <table className="table prices">
          <thead><tr><th>کارت</th><th>قیمت فروش (افغانی)</th><th>سود هر کارت</th><th>فعال</th></tr></thead>
          <tbody>
            {cards.map((c, i) => {
              const profit = amount(c.price) - c.volume_gb * amount(cost);
              return (
                <tr key={c.volume_gb} className={c.active ? "" : "inactive"}>
                  <td><strong dir="ltr">{fa2(c.volume_gb)}GB</strong></td>
                  <td><input dir="ltr" inputMode="decimal" value={c.price} onChange={(e) => edit(i, { price: decimal(e.target.value) })} /></td>
                  <td className={profit < 0 ? "num form-error inline" : "num"}>{fa2(profit)}</td>
                  <td><input type="checkbox" checked={c.active} onChange={(e) => edit(i, { active: e.target.checked })} aria-label="فعال" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {saved && <p className="form-ok" role="status">ذخیره شد.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions"><button className="btn" onClick={() => void save()}>ذخیره</button></div>
    </section>
  );
}
