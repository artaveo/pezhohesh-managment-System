// Amounts typed into a box are kept as text while typing, so "7." can become "7.5".

/** What may be typed in an amount box: digits and one decimal point. */
export const decimal = (s: string) => s.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/** The amount in a box; nothing (or nonsense) is 0. */
export const amount = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);

const upTo2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
/** A number with up to two decimals (GB of cards, cost per GB); `fa` rounds to whole Afghani. */
export const fa2 = (n: number) => upTo2.format(n);
