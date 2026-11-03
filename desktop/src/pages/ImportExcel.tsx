import { useState, type FormEvent } from "react";
import { api, errorText, type ImportClash, type ImportLine, type ImportReport } from "../lib/api";
import { fa, yearNumber } from "../lib/solar";
import { PasswordInput } from "../components/PasswordInput";
import { Icon } from "../components/Icon";

const MONTHS = ["حمل", "ثور", "جوزا", "سرطان", "اسد", "سنبله", "میزان", "عقرب", "قوس", "جدی", "دلو", "حوت"];
const KIND_LABEL = { income: "درآمد", expense: "مصارف", withdrawal: "برداشت‌ها" } as const;

/**
 * A year's Excel book comes in two steps: a check that changes nothing and shows every
 * statement line next to what would be imported, then the import itself.
 */
export function ImportExcel({ done }: { done: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [year, setYear] = useState(yearNumber());
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  // IDs where the partner said the book is right, and that the clashes were read.
  const [takeExcel, setTakeExcel] = useState<number[]>([]);
  const [seen, setSeen] = useState(false);

  function reset() {
    setReport(null);
    setTakeExcel([]);
    setSeen(false);
  }

  async function run(commit: boolean, take = takeExcel) {
    if (!file) return;
    setBusy(commit ? "import" : "check");
    setError("");
    try {
      setReport(await api.importExcel(file, { year: Number(year), password, commit, takeExcel: take }));
    } catch (e) {
      setError(errorText(e));
      setReport(null);
    } finally {
      setBusy(null);
    }
  }

  function check(e: FormEvent) {
    e.preventDefault();
    setSeen(false);
    void run(false);
  }

  /** «اکسل درست است» for one ID: checked again at once, so the page says what will happen. */
  function toggleTake(no: number) {
    const next = takeExcel.includes(no) ? takeExcel.filter((n) => n !== no) : [...takeExcel, no];
    setTakeExcel(next);
    void run(false, next);
  }

  const clashes = report?.clashes ?? [];
  const open = clashes.filter((c) => c.outcome !== "excel");

  if (report?.committed) {
    return (
      <div className="page">
        <section className="panel">
          <p className="form-ok"><Icon name="check" size={16} /> اکسل سال {report.year} وارد شد.</p>
          <Counts r={report} />
          {open.length > 0 && (
            <p className="form-error">
              {fa(open.length)} آیدی هنوز برای دو نفر است ({open.map((c) => c.no).join("، ")}). پول آن ردیف‌ها در درآمد آمده
              ولی به هیچ عضوی وصل نشده؛ آیدی را در اکسل درست کنید و دوباره وارد کنید.
            </p>
          )}
          <p className="muted">داشبورد، گزارش ماهانه و صورت حساب سالانه حالا همین اعداد را نشان می‌دهند.</p>
          <div className="actions"><button className="btn" onClick={done}>رفتن به داشبورد</button></div>
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <form className="panel import-form" onSubmit={check}>
        <h2>فایل اکسل یک سال</h2>
        <p className="muted">
          مثلاً «دیتابیس 1405». اول فقط بررسی می‌شود و چیزی ذخیره نمی‌شود؛ وقتی جمع‌ها را با شیت «محاسبات» مقایسه کردید، «وارد کن» را بزنید.
        </p>
        <div className="form-grid">
          <label className="field wide">
            <span>فایل (.xlsx)</span>
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset(); }} />
          </label>
          <label className="field wide">
            <span>سال</span>
            <input dir="ltr" inputMode="numeric" value={year} onChange={(e) => { setYear(e.target.value.replace(/\D/g, "")); reset(); }} />
          </label>
          <label className="field wide">
            <span>رمز فایل (اگر دارد)</span>
            <PasswordInput value={password} onChange={(v) => { setPassword(v); reset(); }} autoComplete="off" />
          </label>
        </div>
        <p className="muted small">
          اعضا، همهٔ پرداخت‌ها، مصارف و برداشت‌های شرکا وارد می‌شود. تاریخ شروع عضویت‌ها در اکسل نیست، پس عضویت فعال ساخته نمی‌شود؛
          وقتی مدیر تاریخ شروع را ثبت کند، تاریخ ختم خودکار 30 روز بعد حساب می‌شود.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" disabled={!file || !year || busy !== null}>{busy === "check" ? "در حال بررسی…" : "بررسی فایل"}</button>
        </div>
      </form>

      {report && (
        <>
          <section className="panel wide">
            <h2>نتیجهٔ بررسی سال {report.year}</h2>
            <Counts r={report} />
            {report.replaces && (
              <p className="notice form-ok">
                این سال قبلاً وارد شده است. با وارد کردن دوباره، درآمدها، مصارف و برداشت‌های اکسل قبلی جایگزین می‌شوند.
                اعضا و هر چیزی که در خود برنامه ثبت شده دست نمی‌خورد.
              </p>
            )}
          </section>

          {clashes.length > 0 && <Clashes clashes={clashes} take={toggleTake} busy={busy !== null} />}

          <section className="glass table-wrap">
            <table className="table reconcile">
              <thead>
                <tr><th>سطر صورت حساب</th><th>از کجا</th><th>شیت محاسبات</th><th>وارد می‌شود</th><th>نتیجه</th></tr>
              </thead>
              <tbody>
                {(["income", "expense", "withdrawal"] as const).map((kind) => (
                  <Group key={kind} kind={kind} lines={report.lines.filter((l) => l.kind === kind)} />
                ))}
              </tbody>
            </table>
          </section>

          {report.hotspot.buys + report.hotspot.counts > 0 && <Hotspot r={report} />}

          {report.warnings.length > 0 && (
            <details className="panel wide warnings" open={report.warnings.length <= 8}>
              <summary>{fa(report.warnings.length)} نکته برای چک کردن</summary>
              <ul>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}

          {clashes.length > 0 && (
            <label className="check clash-seen">
              <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} />
              {fa(clashes.length)} آیدیِ دو نفره را خواندم و می‌دانم با هر کدام چه می‌شود.
            </label>
          )}
          <div className="actions">
            <button className="btn big" onClick={() => void run(true)} disabled={busy !== null || (clashes.length > 0 && !seen)}>
              {busy === "import" ? "در حال وارد کردن…" : `وارد کن (سال ${report.year})`}
            </button>
            <button className="btn ghost" onClick={reset} disabled={busy !== null}>انصراف</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * IDs given to two different people. Nothing of the book's person is joined to the app's
 * member until the ID is fixed in the book, or the partner says the book is right.
 */
function Clashes({ clashes, take, busy }: { clashes: ImportClash[]; take: (no: number) => void; busy: boolean }) {
  return (
    <section className="panel wide clashes" role="alert" aria-labelledby="clashes-title">
      <div className="clashes-head">
        <Icon name="alert" size={20} />
        <div>
          <h2 id="clashes-title">{fa(clashes.length)} آیدی برای دو نفر آمده</h2>
          <p className="muted">
            اطلاعات و پرداخت‌های یک نفر به عضو دیگری وصل نمی‌شود. پول این ردیف‌ها در درآمد ماه حساب می‌شود،
            ولی تا آیدی درست نشود به هیچ عضوی وصل نیست.
          </p>
        </div>
      </div>
      <ul className="clash-list">
        {clashes.map((c) => <ClashItem key={c.no} c={c} take={take} busy={busy} />)}
      </ul>
    </section>
  );
}

function ClashItem({ c, take, busy }: { c: ImportClash; take: (no: number) => void; busy: boolean }) {
  const held = c.app && [
    c.app.periods > 0 && `${fa(c.app.periods)} دوره`,
    c.app.bills > 0 && `${fa(c.app.bills)} بل`,
    c.app.documents > 0 && `${fa(c.app.documents)} عکس یا اسکن`,
  ].filter(Boolean).join("، ");
  const person = c.excel[0];
  return (
    <li className={`clash ${c.outcome}`}>
      <div className="clash-no"><span className="muted small">آیدی</span><strong dir="ltr">{c.no}</strong></div>
      <div className="clash-sides">
        {c.app && (
          <div className="clash-side">
            <span className="clash-label">در برنامه{c.app.deleted ? " (حذف‌شده)" : ""}</span>
            <strong>{c.app.name || "بی‌نام"}</strong>
            <Details father={c.app.father} phone={c.app.phone} />
            <span className="muted small">
              {c.app.from_excel ? "از ورود اکسل قبلی" : "در خود برنامه ثبت شده"}
              {held ? ` · ${held} دارد` : " · دوره، بل یا عکسی ندارد"}
            </span>
          </div>
        )}
        {c.excel.map((x, i) => (
          <div className="clash-side" key={i}>
            <span className="clash-label">در اکسل · {x.rows.join(" و ")}</span>
            <strong>{x.name ?? "بی‌نام"}</strong>
            <Details father={x.father} phone={x.phone} />
            <span className="muted small">{x.months.length ? `${fa(x.paid)} افغانی: ${x.months.join("، ")}` : "پرداختی ندارد"}</span>
          </div>
        ))}
      </div>
      <p className="clash-outcome">
        {c.outcome === "none"
          ? "هیچ‌کدام عضو ساخته نمی‌شود. آیدی یکی را در اکسل درست کنید و دوباره «بررسی فایل» را بزنید."
          : c.outcome === "excel"
            ? `عضو ${c.no} برنامه «${person?.name ?? "بی‌نام"}» می‌شود: نام و هر چیزی که اکسل دارد از اکسل گرفته می‌شود و پرداخت‌هایش به او وصل می‌شود.${held ? ` ${held} همین عضو هم با او می‌ماند.` : ""}`
            : `«${c.app?.name || "بی‌نام"}» در برنامه دست نمی‌خورد. اگر آیدی در اکسل اشتباه است، آن را در اکسل درست کنید و دوباره «بررسی فایل» را بزنید.`}
      </p>
      {c.can_take_excel && (
        <label className="check take">
          <input type="checkbox" checked={c.outcome === "excel"} disabled={busy} onChange={() => take(c.no)} />
          اکسل درست است: عضو {c.no} برنامه همان «{person?.name ?? "بی‌نام"}» است
        </label>
      )}
    </li>
  );
}

function Details({ father, phone }: { father: string | null; phone: string | null }) {
  if (!father && !phone) return <span className="muted small">نام پدر و شماره ندارد</span>;
  return (
    <span className="small">
      {father && <>فرزند {father}</>}
      {father && phone && " · "}
      {phone && <span dir="ltr">{phone}</span>}
    </span>
  );
}

function Counts({ r }: { r: ImportReport }) {
  return (
    <ul className="import-counts">
      <li><strong>{fa(r.members)}</strong> عضو <span className="muted small">({fa(r.members_new)} جدید)</span></li>
      <li><strong>{fa(r.receipts)}</strong> پرداخت</li>
      <li><strong>{fa(r.expenses)}</strong> مصرف</li>
      <li><strong>{fa(r.withdrawals)}</strong> برداشت</li>
      {r.hotspot.buys + r.hotspot.counts > 0 && (
        <li><strong>{fa(r.hotspot.buys)}</strong> بل خرید و <strong>{fa(r.hotspot.counts)}</strong> شمارش فروش هاتسپات</li>
      )}
    </ul>
  );
}

function Group({ kind, lines }: { kind: ImportLine["kind"]; lines: ImportLine[] }) {
  const sum = (xs: (number | null)[]) => xs.reduce<number>((t, v) => t + (v ?? 0), 0);
  return (
    <>
      <tr className="section"><th colSpan={5}>{KIND_LABEL[kind]}</th></tr>
      {lines.map((l) => {
        const diffs = l.imported.map((v, i) => v - (l.excel[i] ?? 0)).map((d, i) => ({ d, m: MONTHS[i] })).filter((x) => Math.abs(x.d) >= 1);
        return (
          <tr key={l.key} className={diffs.length ? "differs" : ""}>
            <th scope="row">{l.label}</th>
            <td className="muted small">{l.from_statement ? "جمع ماهانهٔ صورت حساب" : "ردیف به ردیف"}</td>
            <td className="num">{fa(sum(l.excel))}</td>
            <td className="num">{fa(sum(l.imported))}</td>
            <td>
              {diffs.length === 0 ? (
                <span className="status on">برابر</span>
              ) : (
                <span className="status wait" title="ماه‌هایی که با شیت محاسبات فرق دارند">
                  {diffs.map((x) => `${x.m} ${x.d > 0 ? "+" : "−"}${fa(Math.abs(x.d))}`).join("، ")}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** The sheet «انترنت هاتسپات», month by month, next to the statement's hotspot line. */
function Hotspot({ r }: { r: ImportReport }) {
  const rows = r.hotspot.months.map((m, i) => ({ m, name: MONTHS[i] })).filter(({ m }) => m.bought || m.sales || m.statement);
  return (
    <section className="glass table-wrap">
      <table className="table reconcile">
        <caption>شیت «انترنت هاتسپات»</caption>
        <thead>
          <tr><th>ماه</th><th>خرید</th><th>فروش</th><th>سود در شیت</th><th>محاسبات</th><th>در درآمد می‌آید</th></tr>
        </thead>
        <tbody>
          {rows.map(({ m, name }) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td className="num">{fa(m.bought)} <span className="muted small">({fa(m.cards_bought)} کارت)</span></td>
              <td className="num">{fa(m.sales)} <span className="muted small">({fa(m.cards_sold)} کارت)</span></td>
              <td className="num">{fa(m.profit)}</td>
              <td className="num">{m.statement == null ? "—" : fa(m.statement)}</td>
              <td className="num">
                {fa(m.income)} <span className="muted small">{m.from_sheet ? "از شیت" : "از محاسبات"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        خریدها و فروش‌ها برای گزارش هاتسپات و موجودی کارت‌ها وارد می‌شوند. مثل فرمول اکسل، درآمد هاتسپات هر ماه
        «سود فروش» همان ماه در شیت هاتسپات است و در درآمد همان ماه حساب می‌شود.
      </p>
    </section>
  );
}
