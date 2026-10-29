// Amounts in words for printed bills ("یک هزار و دو صد و پنجاه افغانی"), as on the handwritten bills.

const ONES = ["", "یک", "دو", "سه", "چهار", "پنج", "شش", "هفت", "هشت", "نه"];
const TEENS = ["ده", "یازده", "دوازده", "سیزده", "چهارده", "پانزده", "شانزده", "هفده", "هجده", "نزده"];
const TENS = ["", "", "بیست", "سی", "چهل", "پنجاه", "شصت", "هفتاد", "هشتاد", "نود"];
const HUNDREDS = ["", "یک صد", "دو صد", "سه صد", "چهار صد", "پنج صد", "شش صد", "هفت صد", "هشت صد", "نه صد"];
const SCALES = ["", "هزار", "میلیون", "میلیارد"];

function below1000(n: number): string {
  const parts = [HUNDREDS[Math.floor(n / 100)]];
  const r = n % 100;
  if (r >= 10 && r < 20) parts.push(TEENS[r - 10]);
  else parts.push(TENS[Math.floor(r / 10)], ONES[r % 10]);
  return parts.filter(Boolean).join(" و ");
}

export function inWords(amount: number): string {
  let n = Math.round(Math.abs(amount));
  if (n === 0) return "صفر";
  const groups: string[] = [];
  for (let i = 0; n > 0 && i < SCALES.length; i++, n = Math.floor(n / 1000)) {
    const g = n % 1000;
    if (g) groups.unshift([below1000(g), SCALES[i]].filter(Boolean).join(" "));
  }
  return groups.join(" و ");
}
