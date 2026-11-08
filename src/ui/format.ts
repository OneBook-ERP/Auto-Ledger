/** Formats integer paise as rupees with Indian digit grouping: 51293276 -> "₹5,12,932.76". */
export function formatInr(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100).toString();
  const paise = (abs % 100).toString().padStart(2, '0');
  const head = rupees.length > 3 ? rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + rupees.slice(-3) : rupees;
  return `${neg ? '-' : ''}₹${head}.${paise}`;
}
