export const MONTHS = Object.freeze(["all", "2026-09", "2026-10", "2026-11", "2026-12"]);
export const INVOICES = Object.freeze([
  { id: "DEMO-1001", date: "2026-09-15", cents: 12000, status: "Paid" },
  { id: "DEMO-1002", date: "2026-10-05", cents: 24000, status: "Paid" },
  { id: "DEMO-1003", date: "2026-10-20", cents: 8550, status: "Unpaid" },
  { id: "DEMO-1004", date: "2026-11-01", cents: 16000, status: "Unpaid" },
].map((invoice) => Object.freeze(invoice)));
export const amount = (cents) => `USD ${(cents / 100).toFixed(2)}`;
export const invoicesFor = (month) => INVOICES.filter((invoice) => month === "all" || invoice.date.startsWith(month));

// Minimal, deterministic, one-page text PDF. All content is owned ASCII fixture data.
export function invoicePdf(invoice) {
  if (!INVOICES.includes(invoice)) throw Error("unknown_invoice");
  const lines = ["Eclipse Demo Supply", "SYNTHETIC INVOICE - DEMO ONLY", invoice.id,
    `Date: ${invoice.date}`, `Total: ${amount(invoice.cents)}`, `Status: ${invoice.status}`,
    "No payment is due. This is fictional test data."];
  const escape = (line) => line.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 14 Tf 48 760 Td 24 TL ${lines.map((line, i) => `${i ? "T* " : ""}(${escape(line)}) Tj`).join("\n")} ET\n`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text, "ascii");
}
