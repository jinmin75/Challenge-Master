// Synthetic PDFs shared by the unit tests and the browser checks. Page 1 has text (English, or one Korean
// character through a ToUnicode map); page 2 is empty.
export function tinyPdf({ korean = false } = {}) {
  const stream = korean ? 'BT /F1 14 Tf 72 720 Td <01> Tj ET'
    : 'BT /F1 14 Tf 72 720 Td (Synthetic page one) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    korean ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 8 0 R >>'
      : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Length 0 >>\nstream\n\nendstream'
  ];
  if (korean) {
    const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
      + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
      + '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n'
      + '1 beginbfchar\n<01> <D55C>\nendbfchar\n'
      + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);
  }
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, 'latin1');
}
