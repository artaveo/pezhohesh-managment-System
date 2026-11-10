import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type Note, type NoteInput, type NoteLine } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { decimal } from "../lib/numbers";
import { SolarDate } from "../components/SolarDate";
import { RemoveButton } from "../components/RemoveButton";
import { Icon } from "../components/Icon";

const blank = (): NoteInput => ({ title: "", body: null, lines: [], currency: "AFN", noted_on: iso(new Date()), pinned: false });
const unit = (c: string) => (c === "USD" ? "$" : "؋");

/** What came in, what went out, and what is left of a note's lines. */
function totals(lines: NoteLine[]) {
  const inn = lines.filter((l) => !l.out).reduce((s, l) => s + l.amount, 0);
  const out = lines.filter((l) => l.out).reduce((s, l) => s + l.amount, 0);
  return { inn, out, left: inn - out };
}

/**
 * «یادداشت‌ها»: reckonings kept beside the books (a partners' loan, a promise, a plan's
 * figures). Nothing here reaches income, expenses, the till or any report. A note saves
 * itself a moment after typing stops, as notes apps do.
 */
export function Notes() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  // The open note: an id, or "new" for one not saved yet.
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteInput>(blank);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"" | "saving" | "saved" | "failed">("");
  const saving = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    api.notes(ctl.signal).then((n) => { setNotes(n); setOpen((o) => o ?? n[0]?.id ?? null); }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, []);

  // Opening a note fills the editor with it.
  useEffect(() => {
    if (!open || open === "new" || !notes) return;
    const n = notes.find((x) => x.id === open);
    if (n) {
      setDraft({ title: n.title, body: n.body, lines: n.lines, currency: n.currency, noted_on: n.noted_on, pinned: n.pinned });
      setDirty(false);
      setState("");
    }
    // Only when another note is opened, not when the list is refreshed by a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, notes === null]);

  async function save(d: NoteInput, id: string) {
    if (!d.title.trim()) return;
    setState("saving");
    try {
      if (id === "new") {
        const nid = await api.createNote(d);
        const row: Note = { ...d, id: nid, created_by: null, updated_at: new Date().toISOString() };
        setNotes((ns) => [row, ...(ns ?? [])]);
        setOpen(nid);
      } else {
        await api.updateNote(id, d);
        setNotes((ns) => (ns ?? []).map((n) => (n.id === id ? { ...n, ...d, updated_at: new Date().toISOString() } : n)));
      }
      setDirty(false);
      setState("saved");
    } catch (e) {
      setState("failed");
      setError(errorText(e));
    }
  }

  // Saved a moment after the last change.
  useEffect(() => {
    if (!dirty || !open || !draft.title.trim()) return;
    const t = window.setTimeout(() => { saving.current = save(draft, open); }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty]);

  const change = (p: Partial<NoteInput>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); setError(""); };
  const setLine = (i: number, p: Partial<NoteLine>) => change({ lines: draft.lines.map((l, k) => (k === i ? { ...l, ...p } : l)) });

  async function openNote(id: string) {
    if (id === open) return;
    // What was typed is kept before another note opens.
    if (dirty && open && draft.title.trim()) await save(draft, open);
    setOpen(id);
  }
  async function startNew() {
    if (dirty && open && draft.title.trim()) await save(draft, open);
    setOpen("new");
    setDraft(blank());
    setDirty(false);
    setState("");
  }
  async function remove() {
    if (!open) return;
    if (open !== "new") {
      try { await api.deleteNote(open); } catch (e) { setError(errorText(e)); return; }
    }
    const rest = (notes ?? []).filter((n) => n.id !== open);
    setNotes(rest);
    setOpen(rest[0]?.id ?? null);
    setDirty(false);
  }

  const shown = useMemo(() => {
    const q = query.trim();
    const all = notes ?? [];
    const hit = q ? all.filter((n) => n.title.includes(q) || (n.body ?? "").includes(q) || n.lines.some((l) => l.label.includes(q))) : all;
    // A pinned note stays on top even after an edit.
    return [...hit].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }, [notes, query]);

  if (!notes) return error ? <p className="form-error" role="alert">{error}</p> : <p className="muted">در حال خواندن…</p>;
  const t = totals(draft.lines);
  const u = unit(draft.currency);

  return (
    <div className="notes">
      <aside className="notes-list glass" aria-label="یادداشت‌ها">
        <div className="notes-tools">
          <input className="search" type="search" placeholder="جستجو در یادداشت‌ها" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="جستجو در یادداشت‌ها" />
          <button className="btn" onClick={() => void startNew()}><Icon name="plus" size={16} /> یادداشت تازه</button>
        </div>
        {open === "new" && (
          <button className="note-row on" aria-current="true">
            <strong>{draft.title.trim() || "یادداشت تازه"}</strong>
            <span className="muted small">هنوز ذخیره نشده</span>
          </button>
        )}
        {shown.map((n) => {
          const s = totals(n.lines);
          return (
            <button key={n.id} className={`note-row${n.id === open ? " on" : ""}`} aria-current={n.id === open ? "true" : undefined} onClick={() => void openNote(n.id)}>
              <span className="note-row-head">
                {n.pinned && <span className="note-pin" aria-label="سنجاق‌شده"><Icon name="pin" size={14} /></span>}
                <strong>{n.title}</strong>
              </span>
              <span className="note-row-meta">
                <span>{formatDay(n.noted_on)}</span>
                {n.lines.length > 0 && <span className={`num ${s.left < 0 ? "neg" : ""}`}>{fa(s.left)} {unit(n.currency)}</span>}
              </span>
            </button>
          );
        })}
        {!shown.length && open !== "new" && (
          <p className="muted empty">{query ? "یادداشتی با این نوشته پیدا نشد." : "هنوز یادداشتی نیست."}</p>
        )}
      </aside>

      {open ? (
        <section className="note-editor glass" aria-label="یادداشت">
          <div className="note-top">
            <input className="note-title" value={draft.title} placeholder="عنوان یادداشت" autoFocus={open === "new"}
              onChange={(e) => change({ title: e.target.value })} aria-label="عنوان" maxLength={200} />
            <div className="note-actions">
              <span className="note-state muted small" role="status">
                {state === "saving" ? "در حال ذخیره…" : state === "saved" && !dirty ? "ذخیره شد" : state === "failed" ? "ذخیره نشد" : !draft.title.trim() && dirty ? "برای ذخیره عنوان بنویسید" : ""}
              </span>
              <button className={`btn small ghost${draft.pinned ? " on" : ""}`} aria-pressed={draft.pinned} onClick={() => change({ pinned: !draft.pinned })}>
                <Icon name="pin" size={14} /> {draft.pinned ? "سنجاق‌شده" : "سنجاق"}
              </button>
              <RemoveButton onConfirm={() => void remove()} />
            </div>
          </div>
          <p className="note-hint muted small">این یادداشت در هیچ درآمد، مصرف، موجودی یا گزارشی شمرده نمی‌شود.</p>

          <div className="note-meta">
            <SolarDate label="تاریخ" value={draft.noted_on} onChange={(d) => d && change({ noted_on: d })} />
            <label className="field">
              <span>واحد پول</span>
              <select value={draft.currency} onChange={(e) => change({ currency: e.target.value as "AFN" | "USD" })}>
                <option value="AFN">افغانی</option>
                <option value="USD">دالر</option>
              </select>
            </label>
          </div>

          <textarea className="note-body" rows={5} placeholder="شرح، هر چه باید یادتان بماند…" value={draft.body ?? ""}
            onChange={(e) => change({ body: e.target.value })} aria-label="شرح" />

          <div className="note-lines">
            <div className="note-lines-head">
              <h2>حساب</h2>
              <button className="btn small ghost" onClick={() => change({ lines: [...draft.lines, { label: "", amount: 0, out: false }] })}>
                <Icon name="plus" size={14} /> سطر تازه
              </button>
            </div>
            {draft.lines.length > 0 ? (
              <table className="table note-table">
                <thead><tr><th>شرح</th><th>آمد / رفت</th><th className="num">مبلغ ({u})</th><th /></tr></thead>
                <tbody>
                  {draft.lines.map((l, i) => (
                    <tr key={i}>
                      <td><input value={l.label} placeholder="مثلاً قرض به رحیمی" onChange={(e) => setLine(i, { label: e.target.value })} aria-label={`شرح سطر ${i + 1}`} /></td>
                      <td>
                        <div className="segmented sub" role="group" aria-label="آمد یا رفت">
                          <button aria-pressed={!l.out} className={!l.out ? "on" : ""} onClick={() => setLine(i, { out: false })}>آمد +</button>
                          <button aria-pressed={l.out} className={l.out ? "on out" : ""} onClick={() => setLine(i, { out: true })}>رفت −</button>
                        </div>
                      </td>
                      <td className="num">
                        <AmountCell value={l.amount} onChange={(amount) => setLine(i, { amount })} label={`مبلغ سطر ${i + 1}`} />
                      </td>
                      <td><button className="icon-btn" aria-label={`حذف سطر ${i + 1}`} title="حذف سطر" onClick={() => change({ lines: draft.lines.filter((_, k) => k !== i) })}><Icon name="trash" size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><th colSpan={2}>آمد</th><td className="num">{fa(t.inn)}</td><td /></tr>
                  <tr><th colSpan={2}>رفت</th><td className="num">{fa(t.out)}</td><td /></tr>
                  <tr className="net"><th colSpan={2}>باقی</th><td className={`num ${t.left < 0 ? "neg" : ""}`}>{fa(t.left)}</td><td /></tr>
                </tfoot>
              </table>
            ) : (
              <p className="muted small">اگر این یادداشت حساب دارد، سطر بزنید؛ جمع و باقی خودش حساب می‌شود.</p>
            )}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </section>
      ) : (
        <section className="note-editor glass note-empty">
          <Icon name="note" size={32} />
          <h2>حساب‌های کنار دفتر</h2>
          <p className="muted">قرض میان شرکا، وعده‌ها، حساب یک خرید بزرگ… هر چه باید یادتان بماند ولی جزو درآمد و مصرف نیست.</p>
          <button className="btn" onClick={() => void startNew()}><Icon name="plus" size={16} /> یادداشت تازه</button>
        </section>
      )}
    </div>
  );
}

/** An amount typed as text, so «12.» can be on its way to «12.5»; the number goes up as it is typed. */
function AmountCell({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => { if ((Number(text) || 0) !== value) setText(value ? String(value) : ""); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input dir="ltr" inputMode="decimal" value={text} placeholder="0" aria-label={label}
      onChange={(e) => { const t = decimal(e.target.value); setText(t); onChange(Number(t) || 0); }} />
  );
}
