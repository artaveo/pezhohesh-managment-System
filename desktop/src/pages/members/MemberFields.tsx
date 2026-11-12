import type { MemberInput } from "../../lib/api";

export const EMPTY_MEMBER: MemberInput = {
  member_no: null, first_name: "", last_name: "", father_name: "", phone: "", emergency_phone: "", field_of_study: "", tazkira_no: "", notes: "",
};

/** Name, father's name, phone… The member number is the one stored in the fingerprint device. */
export function MemberFields({ value, onChange, isNew = false }: { value: MemberInput; onChange: (m: MemberInput) => void; isNew?: boolean }) {
  const set = (k: keyof MemberInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value;
    onChange({ ...value, [k]: k === "member_no" ? (v.replace(/\D/g, "") ? Number(v.replace(/\D/g, "")) : null) : v });
  };
  return (
    <div className="form-grid">
      <label className="field wide">
        <span>آیدی (شمارهٔ عضویت و دستگاه اثر انگشت)</span>
        <input dir="ltr" inputMode="numeric" value={value.member_no ?? ""} onChange={set("member_no")} />
      </label>
      <label className="field wide"><span>نام *</span><input value={value.first_name} onChange={set("first_name")} autoFocus /></label>
      <label className="field wide"><span>تخلص</span><input value={value.last_name ?? ""} onChange={set("last_name")} /></label>
      <label className="field wide"><span>نام پدر</span><input value={value.father_name ?? ""} onChange={set("father_name")} /></label>
      <label className="field wide"><span>شماره تماس</span><input dir="ltr" inputMode="tel" value={value.phone ?? ""} onChange={set("phone")} /></label>
      {/* Required for a new member; members from before may have it empty until it is filled. */}
      <label className="field wide">
        <span>شمارهٔ تماس اضطراری (اقارب){isNew ? " *" : ""}</span>
        <input dir="ltr" inputMode="tel" value={value.emergency_phone ?? ""} onChange={set("emergency_phone")} required={isNew} />
      </label>
      <label className="field wide">
        <span>وضعیت</span>
        <input list="member-status" value={value.field_of_study ?? ""} onChange={set("field_of_study")} placeholder="محصل، متعلم زبان…" />
        {/* The values of the Excel book's «وضعیت» column; anything else can be typed. */}
        <datalist id="member-status">{["محصل", "متعلم زبان", "آموزش شغلی", "مطالعه آزاد"].map((v) => <option key={v} value={v} />)}</datalist>
      </label>
      <label className="field wide"><span>نمبر تذکره</span><input dir="ltr" value={value.tazkira_no ?? ""} onChange={set("tazkira_no")} /></label>
      <label className="field wide span-2"><span>یادداشت</span><input value={value.notes ?? ""} onChange={set("notes")} /></label>
    </div>
  );
}
