/** All money is integer kobo (₦1 = 100 kobo). */
export const kobo = (naira: number) => Math.round(naira * 100);
export const naira = (k: number) => k / 100;
export const formatNaira = (k: number) => `₦${(k / 100).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;
/** percent of an amount, rounded to whole kobo */
export const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);
