/** Minimal valid, blank PDF for metadata/Read tests; no renderer is involved. */
export function makePdf(pages: number): Buffer {
  if (!Number.isSafeInteger(pages) || pages < 1) throw Error("pages must be a positive integer");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"),
  ];
  let content = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n");
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
