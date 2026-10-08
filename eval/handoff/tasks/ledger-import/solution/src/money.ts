export function parseAmount(text: string): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error(`invalid amount "${text}"`);
  }
  const negative = text.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
