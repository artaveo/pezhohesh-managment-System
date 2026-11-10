import { useEffect, useState, type ReactNode } from "react";
import { api, errorText, type DebtGroup, type DebtItem, type DebtKind, type Debts, type HotspotCard, type PaidBill } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { amount, decimal } from "../lib/numbers";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { BillPreview } from "../components/BillSheet";
import { SolarDate } from "../components/SolarDate";
import { AmountInput } from "../components/AmountInput";
import { RemoveButton } from "../components/RemoveButton";
import { Modal } from "../components/Modal";
import { ReturnBook } from "./Books";

export const DEBT_KIND: Record<DebtKind, string> = {
  monthly: "عضویت ماهانه", daily: "عضویت روزانه", internet: "انترنت ماهانه", hotspot: "کارت هاتسپات",
  books: "کتاب", other: "دیگر", overdue: "کتاب دیرکرده",
};
const KIND_ORDER: DebtKind[] = ["monthly", "daily", "internet", "hotspot", "books", "overdue", "other"];

/** The kinds a person owes for, with how many of each: «عضویت ماهانه ۲ · کتاب ۱». */
function KindChips({ items }: { items: DebtItem[] }) {
  const n = new Map<DebtKind, number>();
  for (const i of items) n.set(i.kind, (n.get(i.kind) ?? 0) + 1);
  return (
    <span className="debt-kinds">
      {KIND_ORDER.filter((k) => n.has(k)).map((k) => (
        <span key={k} className={`debt-kind k-${k}`}>{DEBT_KIND[k]}{n.get(k)! > 1 && <b> {fa(n.get(k)!)}</b>}</span>
      ))}
    </span>
  );
}

const who = (g: DebtGroup) => g.member_no !== null ? `آیدی ${g.member_no}` : g.card_no ? `کارت ${g.card_no}` : "بدون آیدی";

/**
 * Everyone who owes anything: a period paid in part, a hotspot card or a book's fee taken on
 * credit, a book kept past its date. One row a person; the period filter narrows to debts
 * from those days.
 */
export function DebtsList({ open, action }: { open: (g: DebtGroup) => void; action: ReactNode }) {
  const period = usePeriod("all");
  const { from, to, label } = period.range;
  const [q, setQ] = useState("");
  const [data, setData] = useState<Debts | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.debts({ q: q.trim() || undefined, from, to }, ctl.signal)
        .then((d) => { setData(d); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q, from, to]);

  return (
    <div className="page">
      <div className="list-tools">
        <input className="search" type="search" placeholder="جستجو: نام، شماره تماس، آیدی یا کارت" aria-label="جستجو: نام، شماره تماس، آیدی یا کارت" value={q} onChange={(e) => setQ(e.target.value)} />
        {action}
      </div>
      <PeriodPicker value={period.value} onChange={period.setValue} />
      {data && (
        <dl className="sum-line">
          <div><dt>جمع باقی ({label})</dt><dd className="num debt-amount">{fa(data.sum)} ؋</dd></div>
          <div><dt>نفر</dt><dd className="num">{fa(data.people)}</dd></div>
          <div><dt>قلم</dt><dd className="num">{fa(data.items)}</dd></div>
        </dl>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>نام</th><th>شماره تماس</th><th>بابت</th><th>از تاریخ</th><th className="num">باقی</th></tr></thead>
          <tbody>
            {data?.groups.map((g) => {
              const oldest = g.items.reduce((d, i) => (i.on_day < d ? i.on_day : d), g.items[0].on_day);
              return (
                <tr key={g.key} className="clickable" onClick={() => open(g)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(g); } }}>
                  <td>
                    <strong>{g.name}</strong>
                    <span className="count-chip" title={`${fa(g.items.length)} قلم باقی`}>{fa(g.items.length)}</span>
                    <div className="muted small">{who(g)}</div>
                  </td>
                  <td><bdi dir="ltr">{g.phone ?? "—"}</bdi></td>
                  <td><KindChips items={g.items} /></td>
                  <td>{formatDay(oldest)}</td>
                  <td className="num debt-amount">{fa(g.total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !data.groups.length && <p className="muted empty">{q ? "چیزی پیدا نشد." : "هیچ کسی باقی ندارد."}</p>}
        {!data && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
    </div>
  );
}

/**
 * One person's debts, each on its own line: tick the ones paid now and change an amount if
 * only part is paid. Each is paid with its own bill dated today; its money still counts in
 * the month it was owed for.
 */
export function DebtItems({ groupKey, person, onChanged }: {
  groupKey: string;
  /** Who a new debt is written for. */
  person: { member_id?: string | null; deposit_id?: string | null; name?: string; phone?: string | null };
  onChanged?: () => void;
}) {
  const [g, setG] = useState<DebtGroup | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [paid, setPaid] = useState<PaidBill[]>([]);
  const [show, setShow] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    api.debts({ key: groupKey }, ctl.signal)
      .then((d) => { setG(d.groups[0] ?? null); setError(""); })
      .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [groupKey, tick]);
  const reload = () => { setPick({}); setTick((t) => t + 1); onChanged?.(); };

  const payable = (i: DebtItem) => i.source !== "loan";
  const chosen = (g?.items ?? []).filter((i) => payable(i) && pick[i.id] !== undefined);
  const sum = chosen.reduce((t, i) => t + Math.min(amount(pick[i.id]), i.owed), 0);
  const toggle = (i: DebtItem) => setPick((p) => {
    const n = { ...p };
    if (n[i.id] === undefined) n[i.id] = String(i.owed); else delete n[i.id];
    return n;
  });
  const all = () => setPick(Object.fromEntries((g?.items ?? []).filter(payable).map((i) => [i.id, String(i.owed)])));

  async function pay() {
    setBusy(true);
    setError("");
    try {
      const bills = await api.payDebts(chosen.map((i) => ({ source: i.source as "period" | "debt", id: i.id, amount: Math.min(amount(pick[i.id]), i.owed) })));
      setPaid(bills);
      if (bills.length === 1) setShow(bills[0].id);
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(i: DebtItem) {
    try { await api.deleteDebt(i.id); reload(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <section className="panel wide debt-panel">
      <div className="panel-head">
        <h2>باقی‌ها{g && <span className="debt-amount"> · {fa(g.total)} ؋</span>}</h2>
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ باقی تازه</button>
      </div>
      {paid.length > 0 && (
        <p className="form-ok" role="status">
          پرداخت ثبت شد: {paid.map((b, n) => (
            <span key={b.id}>{n > 0 && " · "}<button className="link" onClick={() => setShow(b.id)}><bdi dir="ltr">{b.receipt_no}</bdi></button> ({fa(b.amount)})</span>
          ))}
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {g === undefined && !error && <p className="muted">در حال بارگذاری…</p>}
      {g === null && <p className="muted">باقی ندارد.</p>}
      {g && (
        <>
          <ul className="debt-list">
            {g.items.map((i) => {
              const on = pick[i.id] !== undefined;
              return (
                <li key={`${i.source}-${i.id}`} className={on ? "on" : ""}>
                  {payable(i)
                    ? <input type="checkbox" checked={on} onChange={() => toggle(i)} aria-label={`پرداخت ${i.title}`} />
                    : <span className="debt-dot" aria-hidden="true" />}
                  <div className="debt-what">
                    <strong>{i.title}</strong>
                    {!i.title.includes(DEBT_KIND[i.kind]) && <span className={`debt-kind k-${i.kind}`}>{DEBT_KIND[i.kind]}</span>}
                    <div className="muted small">
                      {i.source === "loan"
                        ? <>امانت {formatDay(i.on_day)} · موعد {formatDay(i.until!)} · {fa(i.days_late ?? 0)} روز دیر · فیس {fa(i.fee ?? 0)} + جریمه {fa(i.fine ?? 0)} تا امروز</>
                        : <>{i.until ? <>{formatDay(i.on_day)} تا {formatDay(i.until)}</> : formatDay(i.on_day)}
                          {i.paid > 0 && <> · از {fa(i.due)} پرداخت {fa(i.paid)}</>}
                          {i.receipt_no && <> · بل <bdi dir="ltr">{i.receipt_no}</bdi></>}
                          {i.note && <> · {i.note}</>}</>}
                    </div>
                  </div>
                  <div className="debt-act">
                    {on ? (
                      <label className="debt-pay">
                        <span className="sr-only">مبلغ پرداخت</span>
                        <input dir="ltr" inputMode="decimal" value={pick[i.id]} onChange={(e) => setPick({ ...pick, [i.id]: decimal(e.target.value) })} />
                        <span className="muted small">از {fa(i.owed)}</span>
                      </label>
                    ) : <span className="num debt-amount">{fa(i.owed)}</span>}
                    {i.source === "loan" && <button className="btn small" onClick={() => setReturning(i.id)}>برگشت کتاب</button>}
                    {i.source === "debt" && i.paid === 0 && <RemoveButton onConfirm={() => void remove(i)} />}
                  </div>
                </li>
              );
            })}
          </ul>
          {g.items.some(payable) && <div className="actions debt-foot">
            <button className="btn big" disabled={!chosen.length || !(sum > 0) || busy} onClick={() => void pay()}>
              {chosen.length ? `پرداخت ${fa(sum)} افغانی (${fa(chosen.length)} بل)` : "قلم‌های پرداخت را انتخاب کنید"}
            </button>
            {g.items.filter(payable).length > 1 && <button className="btn ghost" onClick={all}>همه</button>}
            {chosen.length > 0 && <button className="btn ghost" onClick={() => setPick({})}>هیچ</button>}
          </div>}
          <p className="muted small">هر قلم بل جدا با تاریخ امروز می‌گیرد؛ پولش در ماهی حساب می‌شود که باقی مانده بود. کتاب دیرکرده با «برگشت کتاب» حساب می‌شود.</p>
        </>
      )}
      {show && <BillPreview id={show} onClose={() => setShow(null)} />}
      {returning && <ReturnBook id={returning} onClose={(r) => { setReturning(null); reload(); if (r) setShow(r); }} />}
      {adding && <NewDebt person={person} onClose={(saved) => { setAdding(false); if (saved) reload(); }} />}
    </section>
  );
}

/** Writes down something owed: hotspot cards taken on credit (they leave the stock now), a book's fee, or anything else. */
function NewDebt({ person, onClose }: {
  person: { member_id?: string | null; deposit_id?: string | null; name?: string; phone?: string | null };
  onClose: (saved: boolean) => void;
}) {
  const [kind, setKind] = useState<"hotspot" | "books" | "other">("hotspot");
  const [cards, setCards] = useState<HotspotCard[]>([]);
  const [gb, setGb] = useState<number | null>(null);
  const [qty, setQty] = useState("1");
  const [title, setTitle] = useState("");
  const [sum, setSum] = useState("");
  const [on, setOn] = useState(iso(new Date()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.hotspotCards().then((c) => {
      const active = c.cards.filter((x) => x.active);
      setCards(active);
      setGb(active.find((x) => x.in_hand > 0)?.volume_gb ?? active[0]?.volume_gb ?? null);
    }).catch(() => {});
  }, []);
  const card = cards.find((c) => c.volume_gb === gb);
  const ok = kind === "hotspot" ? !!card && amount(qty) > 0 && amount(qty) <= card.in_hand : amount(sum) > 0 && !!title.trim();

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.addDebt({
        member_id: person.member_id ?? undefined, deposit_id: person.deposit_id ?? undefined,
        guest_name: person.member_id || person.deposit_id ? undefined : person.name, phone: person.phone ?? undefined,
        kind, owed_on: on, note: note.trim() || undefined,
        ...(kind === "hotspot" ? { volume_gb: gb!, quantity: amount(qty) } : { title: title.trim(), amount: amount(sum) }),
      });
      onClose(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal label="باقی تازه" onClose={() => onClose(false)}>
      <h2>باقی تازه</h2>
      <div className="segmented sub" role="radiogroup" aria-label="بابت">
        {(["hotspot", "books", "other"] as const).map((k) => (
          <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{DEBT_KIND[k]}</button>
        ))}
      </div>
      <div className="form-grid">
        {kind === "hotspot" ? (
          <>
            <label className="field wide">
              <span>کارت</span>
              <select value={gb ?? ""} onChange={(e) => setGb(Number(e.target.value))}>
                {cards.map((c) => <option key={c.volume_gb} value={c.volume_gb} disabled={c.in_hand <= 0}>{fa(c.volume_gb)} GB · {fa(c.price)} ؋ · {fa(c.in_hand)} در دست</option>)}
              </select>
            </label>
            <label className="field wide">
              <span>تعداد</span>
              <input dir="ltr" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
              {card && <small className="muted">{fa(amount(qty) * card.price)} افغانی · کارت‌ها همین حالا از موجودی کم می‌شوند.</small>}
            </label>
          </>
        ) : (
          <>
            <label className="field wide span-2"><span>بابت *</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "books" ? "مثلاً فیس کتاب «…»" : ""} /></label>
            <AmountInput label="مبلغ (افغانی)" required value={sum} onChange={setSum} />
          </>
        )}
        <SolarDate label="تاریخ" value={on} onChange={setOn} />
        <label className="field wide span-2"><span>یادداشت</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={!ok || !on || busy} onClick={() => void save()}>ثبت باقی</button>
        <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
      </div>
    </Modal>
  );
}

/** The debt page of someone with no member record: a book card holder, or a name typed at the desk. */
export function DebtPage({ group }: { group: DebtGroup }) {
  return (
    <div className="page">
      <section className="panel wide member-head">
        <div className="member-title">
          <div>
            <h2>{group.name}</h2>
            <p className="muted">
              {who(group)}
              {group.phone && <> · <bdi dir="ltr">{group.phone}</bdi></>}
            </p>
          </div>
        </div>
      </section>
      <DebtItems groupKey={group.key} person={{ member_id: group.member_id, deposit_id: group.deposit_id, name: group.name, phone: group.phone }} />
    </div>
  );
}
