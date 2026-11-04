import { balance, type Sum } from "./reports";

/** The statement line paid to the admin manager (M in the Excel share formula). */
export const MANAGER_SALARY = "اجوره مدیر اداری";

/**
 * The partners' split, as in the Excel statement (سهمیه رحیمی / سهمیه ناصری):
 * Naseri gets (B + M) / 3 and Rahimi 2(B + M) / 3 - M, where B is the balance
 * (income minus expenses) and M the admin manager's pay. The two add up to B.
 * `name` is the partner's staff name, which their withdrawals are listed under.
 */
export const PARTNERS = [
  { name: "ذاکر ناصری", short: "ناصری", part: 1 / 3, paysManager: false },
  { name: "جلیل رحیمی", short: "رحیمی", part: 2 / 3, paysManager: true },
] as const;

/** What the two partners took out of the till in this period. */
export const partnersTaken = (s: Sum) => PARTNERS.reduce((t, p) => t + (s.withdrawals_by_person[p.name] ?? 0), 0);

/** موجودی: the balance less the partners' withdrawals, i.e. what of this period's money should still be in the till. */
export const inTill = (s: Sum) => balance(s) - partnersTaken(s);

export type Share ={ name: string; short: string; share: number; taken: number; left: number };

export function shares(s: Sum): Share[] {
  const b = balance(s);
  const m = s.expenses_by_category[MANAGER_SALARY] ?? 0;
  return PARTNERS.map((p) => {
    const share = p.part * (b + m) - (p.paysManager ? m : 0);
    const taken = s.withdrawals_by_person[p.name] ?? 0;
    return { name: p.name, short: p.short, share, taken, left: share - taken };
  });
}
