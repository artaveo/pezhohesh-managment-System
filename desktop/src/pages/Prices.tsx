import { useEffect, useState } from "react";
import { api, errorText, type Plan, type PlanKind } from "../lib/api";

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
    </div>
  );
}
