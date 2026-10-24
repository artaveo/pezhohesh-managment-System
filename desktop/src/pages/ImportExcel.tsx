import { useState, type FormEvent } from "react";
import { api, errorText, type ImportLine, type ImportReport } from "../lib/api";
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

  async function run(commit: boolean) {
    if (!file) return;
    setBusy(commit ? "import" : "check");
    setError("");
    try {
      setReport(await api.importExcel(file, { year: Number(year), password, commit }));
    } catch (e) {
      setError(errorText(e));
      setReport(null);
    } finally {
      setBusy(null);
    }
  }

  function check(e: FormEvent) {
    e.preventDefault();
    void run(false);
  }

  if (report?.committed) {
    return (
      <div className="page">
        <section className="panel">
          <p className="form-ok"><Icon name="check" size={16} /> اکسل سال {report.year} وارد شد.</p>
          <Counts r={report} />
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
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); }} />
          </label>
          <label className="field wide">
            <span>سال</span>
            <input dir="ltr" inputMode="numeric" value={year} onChange={(e) => { setYear(e.target.value.replace(/\D/g, "")); setReport(null); }} />
          </label>
          <label className="field wide">
            <span>رمز فایل (اگر دارد)</span>
            <PasswordInput value={password} onChange={(v) => { setPassword(v); setReport(null); }} autoComplete="off" />
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

          {report.warnings.length > 0 && (
            <details className="panel wide warnings" open={report.warnings.length <= 8}>
              <summary>{fa(report.warnings.length)} نکته برای چک کردن</summary>
              <ul>{report.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </details>
          )}

          <div className="actions">
            <button className="btn big" onClick={() => void run(true)} disabled={busy !== null}>
              {busy === "import" ? "در حال وارد کردن…" : `وارد کن (سال ${report.year})`}
            </button>
            <button className="btn ghost" onClick={() => setReport(null)} disabled={busy !== null}>انصراف</button>
          </div>
        </>
      )}
    </div>
  );
}

function Counts({ r }: { r: ImportReport }) {
  return (
    <ul className="import-counts">
      <li><strong>{fa(r.members)}</strong> عضو <span className="muted small">({fa(r.members_new)} جدید)</span></li>
      <li><strong>{fa(r.receipts)}</strong> پرداخت</li>
      <li><strong>{fa(r.expenses)}</strong> مصرف</li>
      <li><strong>{fa(r.withdrawals)}</strong> برداشت</li>
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
