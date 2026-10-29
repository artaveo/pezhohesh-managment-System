import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api, errorText,
  type BookSection, type Catalog, type CatalogBook, type CatalogBookInput, type CatalogImport,
} from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { useAuth } from "../auth/AuthProvider";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { PasswordInput } from "../components/PasswordInput";
import { PrintCopy } from "../components/PrintCopy";
import { RemoveButton } from "../components/RemoveButton";

/**
 * Every book on the shelves, by section, as in the book list (لیست کتابها): search it,
 * add or correct a book, bring the Excel list in, and print the list by section.
 */
export function BookCatalog() {
  const partner = useAuth().user!.role === "partner";
  const [q, setQ] = useState("");
  const [section, setSection] = useState("");
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<CatalogBook | "new" | null>(null);
  const [sections, setSections] = useState(false);
  const [importing, setImporting] = useState(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.catalog({ q, section }, ctl.signal).then((c) => { setData(c); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q, section, tick]);

  const reload = () => setTick((t) => t + 1);
  const out = data?.books.reduce((t, b) => t + b.on_loan, 0) ?? 0;
  const filtered = !!(q.trim() || section);

  return (
    <>
      <div className="list-tools">
        <input className="search" type="search" placeholder="جستجو: نام کتاب، نویسنده، کد (553-001) یا قفسه" aria-label="جستجو در فهرست کتاب‌ها" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="filter" aria-label="بخش" value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">همهٔ بخش‌ها</option>
          {data?.sections.map((s) => <option key={s.id} value={s.id}>{s.name} ({fa(s.titles)})</option>)}
        </select>
        <div className="list-tools-end">
          <button className="btn" onClick={() => setEditing("new")}><Icon name="plus" /> کتاب جدید</button>
          <button className="btn ghost" onClick={() => setSections(true)}>بخش‌ها</button>
          {partner && <button className="btn ghost" onClick={() => setImporting(true)}><Icon name="upload" /> از اکسل</button>}
          <button className="btn ghost" disabled={!data?.books.length || printing} onClick={() => setPrinting(true)}><Icon name="receipt" /> چاپ فهرست</button>
        </div>
      </div>
      <p className="muted small">
        {data ? <>
          {fa(data.total_titles)} عنوان · {fa(data.total_copies)} جلد در {fa(data.sections.length)} بخش
          {filtered && <> · پیدا شده: {fa(data.books.length)} عنوان</>}
          {out > 0 && <> · {fa(out)} جلد{filtered ? " از این‌ها" : ""} امانت بیرون</>}
        </> : " "}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>کد</th><th>قفسه</th><th>نام کتاب</th><th>نویسنده</th><th>بخش</th><th>جلد</th><th>موجود</th><th /></tr></thead>
          <tbody>
            {data?.books.map((b) => {
              const left = b.copies - b.on_loan;
              return (
                <tr key={b.id}>
                  <td className="num nowrap"><bdi dir="ltr">{b.code ?? "—"}</bdi></td>
                  <td><bdi dir="ltr">{b.shelf ?? "—"}</bdi></td>
                  <td><strong>{b.title}</strong>{b.note && <div className="muted small">{b.note}</div>}</td>
                  <td>{b.author ?? <span className="muted">—</span>}</td>
                  <td>{b.section ?? <span className="muted">بدون بخش</span>}</td>
                  <td className="num">{fa(b.copies)}</td>
                  <td>
                    {b.on_loan === 0 ? <span className="days ok">همه</span>
                      : left > 0 ? <span className="days due">{fa(left)} موجود · {fa(b.on_loan)} بیرون</span>
                        : <span className="days late">همه بیرون</span>}
                  </td>
                  <td><div className="row-actions"><button className="btn small ghost" onClick={() => setEditing(b)}>اصلاح</button></div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !data.books.length && (
          <p className="muted empty">
            {filtered ? "کتابی پیدا نشد." : partner ? "فهرست کتاب‌ها هنوز خالی است. فایل اکسل فهرست را با «از اکسل» وارد کنید یا کتاب‌ها را یکی‌یکی اضافه کنید." : "فهرست کتاب‌ها هنوز خالی است."}
          </p>
        )}
        {!data && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
      {editing && data && (
        <BookForm book={editing === "new" ? null : editing} sections={data.sections} partner={partner}
          preset={section} onClose={(changed) => { setEditing(null); if (changed) reload(); }} />
      )}
      {sections && data && <Sections sections={data.sections} onClose={(changed) => { setSections(false); if (changed) reload(); }} />}
      {importing && <ImportList onClose={(changed) => { setImporting(false); if (changed) reload(); }} />}
      {data && (
        <PrintCopy on={printing} onDone={() => setPrinting(false)}>
          <PrintList data={data} filtered={filtered} />
        </PrintCopy>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// A book

function BookForm({ book, sections, partner, preset, onClose }: {
  book: CatalogBook | null; sections: BookSection[]; partner: boolean; preset: string; onClose: (changed: boolean) => void;
}) {
  const [sectionId, setSectionId] = useState(book ? book.section_id ?? "" : preset || sections[0]?.id || "");
  const nextCode = (id: string) => sections.find((s) => s.id === id)?.next_code ?? "";
  const [code, setCode] = useState(book ? book.code ?? "" : nextCode(sectionId));
  const [codeTouched, setCodeTouched] = useState(!!book);
  const [shelf, setShelf] = useState(book?.shelf ?? "");
  const [title, setTitle] = useState(book?.title ?? "");
  const [author, setAuthor] = useState(book?.author ?? "");
  const [copies, setCopies] = useState(String(book?.copies ?? 1));
  const [note, setNote] = useState(book?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pickSection(id: string) {
    setSectionId(id);
    // A new book takes the section's next free code until a code is typed by hand.
    if (!codeTouched) setCode(nextCode(id));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body: CatalogBookInput = {
      section_id: sectionId || null, code: code.trim() || null, shelf: shelf.trim() || null,
      title, author: author.trim() || null, copies: Number(copies || 0), note: note.trim() || null,
    };
    try {
      if (book) await api.updateCatalogBook(book.id, body);
      else await api.createCatalogBook(body);
      onClose(true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!book) return;
    try { await api.deleteCatalogBook(book.id); onClose(true); } catch (err) { setError(errorText(err)); }
  }

  return (
    <Modal label={book ? "اصلاح کتاب" : "کتاب جدید"} onClose={() => onClose(false)}>
      <form onSubmit={(e) => void save(e)}>
        <h2>{book ? "اصلاح کتاب" : "کتاب جدید"}</h2>
        <div className="form-grid">
          <label className="field wide span-2">
            <span>نام کتاب *</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <label className="field wide">
            <span>نویسنده</span>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </label>
          <label className="field wide">
            <span>بخش</span>
            <select value={sectionId} onChange={(e) => pickSection(e.target.value)}>
              <option value="">بدون بخش</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
            </select>
          </label>
          <label className="field wide">
            <span>کد</span>
            <input dir="ltr" value={code} placeholder="553-001" onChange={(e) => { setCodeTouched(true); setCode(e.target.value.replace(/[^\d-]/g, "")); }} />
          </label>
          <label className="field wide">
            <span>قفسه</span>
            <input dir="ltr" value={shelf} placeholder="A1" onChange={(e) => setShelf(e.target.value)} />
          </label>
          <label className="field wide">
            <span>تعداد جلد</span>
            <input dir="ltr" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ""))} />
            {book && book.on_loan > 0 && <small className="muted">{fa(book.on_loan)} جلد حالا امانت بیرون است.</small>}
          </label>
          <label className="field wide span-2">
            <span>یادداشت</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={!title.trim() || busy}>{book ? "ذخیره" : "اضافه کن"}</button>
          <button className="btn ghost" type="button" onClick={() => onClose(false)}>انصراف</button>
          {book && partner && book.on_loan === 0 && <span className="muted small">از کتابخانه رفته؟ <RemoveButton onConfirm={() => void remove()} /></span>}
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sections

function Sections({ sections, onClose }: { sections: BookSection[]; onClose: (changed: boolean) => void }) {
  const [rows, setRows] = useState(sections.map((s) => ({ id: s.id, code: s.code, name: s.name })));
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState("");
  const shared = useMemo(() => {
    const n = new Map<string, number>();
    rows.forEach((r) => n.set(r.code, (n.get(r.code) ?? 0) + 1));
    return n;
  }, [rows]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const id = await api.createBookSection({ code: code.trim(), name });
      setRows((r) => [...r, { id, code: code.trim(), name: name.trim() }]);
      setCode("");
      setName("");
      setChanged(true);
    } catch (err) { setError(errorText(err)); }
  }

  async function rename(i: number) {
    const r = rows[i];
    const was = sections.find((s) => s.id === r.id);
    if (was && was.code === r.code && was.name === r.name) return;
    setError("");
    try { await api.updateBookSection(r.id, { code: r.code, name: r.name }); setChanged(true); } catch (err) { setError(errorText(err)); }
  }

  const set = (i: number, k: "code" | "name", v: string) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <Modal label="بخش‌های کتابخانه" onClose={() => onClose(changed)} className="wide">
      <h2>بخش‌های کتابخانه</h2>
      <p className="muted small">شمارهٔ بخش اول کد هر کتاب است (553-001). نام یا شماره را عوض کنید و از خانه بیرون بروید تا ذخیره شود.</p>
      <div className="table-wrap">
        <table className="table prices">
          <thead><tr><th>شماره</th><th>نام بخش</th><th>کتاب‌ها</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const s = sections.find((x) => x.id === r.id);
              return (
                <tr key={r.id}>
                  <td><input dir="ltr" aria-label="شمارهٔ بخش" value={r.code} size={5} onChange={(e) => set(i, "code", e.target.value.replace(/\D/g, ""))} onBlur={() => void rename(i)} /></td>
                  <td>
                    <input aria-label="نام بخش" value={r.name} onChange={(e) => set(i, "name", e.target.value)} onBlur={() => void rename(i)} />
                    {(shared.get(r.code) ?? 0) > 1 && <div className="muted small">شمارهٔ {r.code} برای بخش دیگری هم هست</div>}
                  </td>
                  <td className="num nowrap">{s ? `${fa(s.titles)} عنوان · ${fa(s.copies)} جلد` : "تازه"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form className="form-grid" onSubmit={(e) => void add(e)}>
        <label className="field">
          <span>شمارهٔ بخش تازه</span>
          <input dir="ltr" value={code} placeholder="420" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label className="field wide">
          <span>نام بخش تازه</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="actions"><button className="btn" type="submit" disabled={!code || !name.trim()}><Icon name="plus" /> بخش تازه</button></div>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions"><button className="btn ghost" onClick={() => onClose(changed)}>بستن</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Bringing the Excel list in

function ImportList({ onClose }: { onClose: (changed: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [report, setReport] = useState<CatalogImport | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(commit: boolean) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      setReport(await api.importCatalog(file, { password, commit }));
      setDone(commit);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const r = report;
  return (
    <Modal label="وارد کردن فهرست کتاب‌ها" onClose={() => onClose(done)} className="wide">
      <h2>فهرست کتاب‌ها از اکسل</h2>
      <p className="muted">
        فایل «لیست کتابها». برنامه کامل‌ترین شیت فهرست را خودش پیدا می‌کند. اول فقط بررسی می‌شود؛ بعد «وارد کن».
        کتاب‌ها با بخش و کد شناخته می‌شوند، پس اگر بعداً فهرست تازه‌تر را دوباره وارد کنید، دوبار ثبت نمی‌شوند و فقط تغییرها می‌آیند.
      </p>
      {!done && (
        <div className="form-grid">
          <label className="field wide">
            <span>فایل (.xlsx)</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }} />
          </label>
          <label className="field wide">
            <span>رمز فایل (اگر دارد)</span>
            <PasswordInput value={password} onChange={(v) => { setPassword(v); setReport(null); }} autoComplete="off" />
          </label>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {r && (
        <>
          <p className={done ? "notice ok" : ""}>
            {done ? "وارد شد. " : `از شیت «${r.sheet}»: `}
            {fa(r.titles)} عنوان، {fa(r.copies)} جلد در {fa(r.sections.length)} بخش ·
            تازه {fa(r.added)} · تغییر {fa(r.changed)} · بی‌تغییر {fa(r.unchanged)}
            {r.not_in_file > 0 && <> · {fa(r.not_in_file)} کتاب برنامه در این فایل نیست (می‌مانند)</>}
            {r.loans_linked > 0 && <> · {fa(r.loans_linked)} امانت قبلی به کتابش وصل شد</>}
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>شماره</th><th>بخش</th><th>عنوان</th><th>جلد</th><th>جمع خود اکسل</th><th>تازه</th><th>تغییر</th></tr></thead>
              <tbody>
                {r.sections.map((s) => (
                  <tr key={`${s.code}-${s.name}`} className={s.excel_total !== null && s.excel_total !== s.copies ? "differs" : ""}>
                    <td className="num"><bdi dir="ltr">{s.code}</bdi></td>
                    <td>{s.name}</td>
                    <td className="num">{fa(s.titles)}</td>
                    <td className="num">{fa(s.copies)}</td>
                    <td className="num">{s.excel_total === null ? "—" : fa(s.excel_total)}</td>
                    <td className="num">{fa(s.added)}</td>
                    <td className="num">{fa(s.changed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.warnings.length > 0 && <ul className="warnings">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          {r.retitled.length > 0 && (
            <details>
              <summary>کدهایی که نام کتابشان عوض شد ({fa(r.retitled.length)})</summary>
              <ul className="muted small">{r.retitled.map((t) => <li key={t}>{t}</li>)}</ul>
            </details>
          )}
        </>
      )}
      <div className="actions">
        {!done && <button className="btn ghost" disabled={!file || busy} onClick={() => void run(false)}>{busy && !r ? "در حال خواندن…" : "بررسی"}</button>}
        {!done && r && <button className="btn" disabled={busy} onClick={() => void run(true)}>وارد کن</button>}
        <button className="btn ghost" onClick={() => onClose(done)}>{done ? "بستن" : "انصراف"}</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The printed list, by section with each section's total, like the Excel list

function PrintList({ data, filtered }: { data: Catalog; filtered: boolean }) {
  const groups = new Map<string, CatalogBook[]>();
  for (const b of data.books) {
    const k = b.section_id ?? "";
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const name = (id: string) => {
    const s = data.sections.find((x) => x.id === id);
    return s ? `${s.code} · ${s.name}` : "بدون بخش";
  };
  const copies = data.books.reduce((t, b) => t + b.copies, 0);
  return (
    <article className="report" dir="rtl">
      <header className="report-head">
        <div>
          <h1>لیست کتاب‌های کتابخانه و سالن مطالعه پژوهش</h1>
          <p>{fa(data.books.length)} عنوان · {fa(copies)} جلد{filtered ? " (بخشی از فهرست)" : ""}</p>
        </div>
        <span className="muted small">چاپ {formatDay(iso(new Date()))}</span>
      </header>
      <div className="table-wrap flush">
        <table className="table sheet">
          <thead><tr><th>کد</th><th>قفسه</th><th>نام کتاب</th><th>نویسنده</th><th>جلد</th></tr></thead>
          <tbody>
            {[...groups].map(([id, books]) => (
              <BookGroup key={id || "none"} label={name(id)} books={books} />
            ))}
            <tr className="net"><th scope="row" colSpan={4}>مجموعه عمومی کتب</th><td>{fa(copies)}</td></tr>
          </tbody>
        </table>
      </div>
    </article>
  );
}

function BookGroup({ label, books }: { label: string; books: CatalogBook[] }) {
  return (
    <>
      <tr className="section"><th scope="row" colSpan={5}>بخش {label}</th></tr>
      {books.map((b) => (
        <tr key={b.id}>
          <td className="nowrap"><bdi dir="ltr">{b.code ?? ""}</bdi></td>
          <td><bdi dir="ltr">{b.shelf ?? ""}</bdi></td>
          <td>{b.title}</td>
          <td>{b.author ?? ""}</td>
          <td>{fa(b.copies)}</td>
        </tr>
      ))}
      <tr className="sum"><th scope="row" colSpan={4}>مجموعه کتب این بخش</th><td>{fa(books.reduce((t, b) => t + b.copies, 0))}</td></tr>
    </>
  );
}
