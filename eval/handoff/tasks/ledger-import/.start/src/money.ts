export function parseAmount(text: string): number {
  const value = Number.parseFloat(text);
  if (Number.isNaN(value)) throw new Error(`invalid amount "${text}"`);
  return Math.round(value * 100);
}

export function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}
