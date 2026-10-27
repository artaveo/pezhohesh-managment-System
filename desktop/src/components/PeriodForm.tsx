import { useEffect, useMemo, useState } from "react";
import type { Plan, PeriodInput } from "../lib/api";
import { addDays, fa, formatDay, iso, parseIso } from "../lib/solar";
import { SolarDate } from "./SolarDate";

/**
 * One paid period: which plan, from which day, and what is paid. The end date follows from
 * the plan (30 days: 1 Aqrab to 30 Aqrab). With `recordOnly`, only the dates are kept: the
 * money for it was already taken before the program (the Excel book).
 */
export function PeriodForm({ plans, start, kinds, recordOnly = false, onChange }: {
  plans: Plan[];
  /** Suggested first day for a plan kind (the day after the last period of that kind, or today). */
  start: (kind: Plan["kind"]) => string;
  kinds: Plan["kind"][];
  recordOnly?: boolean;
  onChange: (p: PeriodInput | null) => void;
}) {
  const choices = useMemo(() => plans.filter((p) => p.active && kinds.includes(p.kind)), [plans, kinds]);
  const [planId, setPlanId] = useState(choices[0]?.id ?? "");
  const plan = choices.find((p) => p.id === planId);
  const suggested = start(plan?.kind ?? kinds[0]);
  const [from, setFrom] = useState(suggested);
  const [fee, setFee] = useState("");
  const [discount, setDiscount] = useState("");

  // Seat and internet renew on their own timelines: switching plan moves the suggested day.
  useEffect(() => setFrom(suggested), [suggested]);
  useEffect(() => { if (!plan && choices[0]) setPlanId(choices[0].id); }, [plan, choices]);
  useEffect(() => setFee(plan ? String(plan.price) : ""), [plan]);

  const feeN = Number(fee || 0);
  const discountN = Number(discount || 0);
  const ok = !!plan && from !== "" && (recordOnly || (fee !== "" && feeN >= 0 && discountN >= 0 && discountN <= feeN));
  const end = plan && from ? iso(addDays(parseIso(from), plan.duration_days - 1)) : from;

  useEffect(() => {
    onChange(ok && plan ? { plan_id: plan.id, start_date: from, fee: recordOnly ? 0 : feeN, discount: recordOnly ? 0 : discountN, record_only: recordOnly } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, plan, from, feeN, discountN, recordOnly]);

  if (!choices.length) return <p className="form-error">هیچ نوع عضویتی تعریف نشده. یکی از شرکا در «تنظیمات» قیمت‌ها را اضافه کند.</p>;

  return (
    <div className="period-form">
      <div className="form-grid">
        <label className="field wide">
          <span>نوع عضویت</span>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {choices.map((p) => <option key={p.id} value={p.id}>{p.name} — {fa(p.price)} افغانی</option>)}
          </select>
        </label>
        <SolarDate label="تاریخ شروع" value={from} onChange={setFrom} />
        {!recordOnly && (
          <>
            <label className="field wide">
              <span>مبلغ (افغانی)</span>
              <input dir="ltr" inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
            <label className="field wide">
              <span>تخفیف (اگر دارد)</span>
              <input dir="ltr" inputMode="numeric" value={discount} placeholder="0" onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ""))} />
            </label>
          </>
        )}
      </div>
      {plan && from && (
        <p className="period-sum">
          از <strong>{formatDay(from)}</strong> تا <strong>{formatDay(end)}</strong> ({fa(plan.duration_days)} روز)
          {!recordOnly && <> · پرداخت: <strong>{fa(Math.max(0, feeN - discountN))} افغانی</strong></>}
        </p>
      )}
      {!recordOnly && discountN > feeN && <p className="form-error">تخفیف از مبلغ بیشتر است.</p>}
    </div>
  );
}
