import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MemberRow } from "../lib/api";
import { Icon } from "./Icon";

export type SearchPage = { id: string; label: string; where?: string; icon: string; keywords?: string };

/** Arabic and Persian letters typed either way find each other (ي/ی، ك/ک، ة/ه), and spaces don't matter. */
const norm = (s: string) =>
  s.toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[‌\s]+/g, " ").trim();

/**
 * One search for the whole app (Ctrl+K): the sections and pages by name, and the members by
 * name, father's name, phone or member number. Arrow keys move, Enter opens, Esc closes.
 */
export function SearchPalette({ pages, members, onPage, onMember, onClose }: {
  pages: SearchPage[];
  /** Whether this person may see members (the desk or the list). */
  members: boolean;
  onPage: (id: string) => void;
  onMember: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MemberRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  const hits = useMemo(() => {
    const t = norm(q);
    if (!t) return pages;
    const words = t.split(" ");
    return pages.filter((p) => {
      const hay = norm(`${p.label} ${p.where ?? ""} ${p.keywords ?? ""}`);
      return words.every((w) => hay.includes(w));
    });
  }, [q, pages]);

  // Members are looked up a moment after typing stops, from two letters or a number on.
  useEffect(() => {
    const t = q.trim();
    if (!members || (t.length < 2 && !/^\d+$/.test(t))) { setFound([]); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const timer = window.setTimeout(() => {
      api.members({ scope: "all", q: t, limit: 6 }, ctl.signal)
        .then((p) => { setFound(p.rows.filter((r) => r.member_id)); setBusy(false); })
        .catch(() => { if (!ctl.signal.aborted) setBusy(false); });
    }, 220);
    return () => { window.clearTimeout(timer); ctl.abort(); };
  }, [q, members]);

  const results: ({ kind: "page"; page: SearchPage } | { kind: "member"; m: MemberRow })[] = [
    ...hits.map((page) => ({ kind: "page" as const, page })),
    ...found.map((m) => ({ kind: "member" as const, m })),
  ];
  useEffect(() => { setAt(0); }, [q, found.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  function pick(i: number) {
    const r = results[i];
    if (!r) return;
    if (r.kind === "page") onPage(r.page.id);
    else onMember(r.m.member_id!);
    onClose();
  }
  function key(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(at); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  }

  const firstMember = hits.length;
  return (
    <div className="palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="جستجو در برنامه">
        <div className="palette-input">
          <Icon name="search" size={19} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key}
            placeholder={members ? "بخش، صفحه، نام عضو یا شمارهٔ عضویت…" : "نام بخش یا صفحه…"}
            role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={results.length ? `palette-${at}` : undefined} />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {hits.length > 0 && <div className="palette-group">بخش‌ها</div>}
          {hits.map((p, i) => (
            <button key={p.id} id={`palette-${i}`} data-i={i} role="option" aria-selected={at === i}
              className={at === i ? "on" : ""} onMouseMove={() => setAt(i)} onClick={() => pick(i)}>
              <Icon name={p.icon} size={18} />
              <span className="palette-main">{p.label}</span>
              {p.where && <span className="palette-where">{p.where}</span>}
            </button>
          ))}
          {members && found.length > 0 && <div className="palette-group">اعضا</div>}
          {found.map((m, k) => {
            const i = firstMember + k;
            return (
              <button key={m.member_id} id={`palette-${i}`} data-i={i} role="option" aria-selected={at === i}
                className={at === i ? "on" : ""} onMouseMove={() => setAt(i)} onClick={() => pick(i)}>
                <Icon name="user" size={18} />
                <span className="palette-main">{m.name}</span>
                {m.member_no !== null && <span className="palette-where"><bdi>{m.member_no}</bdi></span>}
              </button>
            );
          })}
          {!results.length && !busy && <p className="palette-empty">چیزی با «{q.trim()}» پیدا نشد.</p>}
          {busy && !found.length && <p className="palette-empty">در حال جستجوی اعضا…</p>}
        </div>
        <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> انتخاب</span><span><kbd>Enter</kbd> باز کردن</span></div>
      </div>
    </div>
  );
}
