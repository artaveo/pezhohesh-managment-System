import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, type MemberInput, type PeriodInput, type Plan } from "../../lib/api";
import { iso } from "../../lib/solar";
import { PeriodForm } from "../../components/PeriodForm";
import { EMPTY_MEMBER, MemberFields } from "./MemberFields";

/** Registers a member and, usually in the same step, their first paid month and its bill. */
export function NewMember({ onSaved, onCancel }: { onSaved: (memberId: string, billId: string | null) => void; onCancel: () => void }) {
  const [member, setMember] = useState<MemberInput>(EMPTY_MEMBER);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [withPeriod, setWithPeriod] = useState(true);
  const [period, setPeriod] = useState<PeriodInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.plans().then(setPlans).catch((e) => setError(errorText(e)));
    api.nextMemberNo().then((n) => setMember((m) => (m.member_no === null ? { ...m, member_no: n } : m))).catch(() => {});
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.createMember(member, withPeriod ? period : null);
      onSaved(r.member_id!, r.receipt_id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = member.first_name.trim() !== "" && (!withPeriod || period !== null);
  return (
    <form className="panel wide" onSubmit={save}>
      <h2>عضو جدید</h2>
      <MemberFields value={member} onChange={setMember} />
      <label className="check big">
        <input type="checkbox" checked={withPeriod} onChange={(e) => setWithPeriod(e.target.checked)} />
        عضویت اول را هم ثبت کن و بل بده
      </label>
      {withPeriod && <PeriodForm plans={plans} start={() => iso(new Date())} kinds={["monthly", "internet"]} onChange={setPeriod} />}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn big" disabled={!ready || busy}>{busy ? "در حال ثبت…" : withPeriod ? "ثبت و بل" : "ثبت عضو"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </form>
  );
}
