import XLSX from 'xlsx-js-style';

const BRAND_RED = '8B1A1A';
const BRAND_RED_DARK = '6B1515';
const WHITE = 'FFFFFF';
const TEXT_DARK = '1F2937';
const ROW_ALT = 'FDF2F2';
const ROW_WHITE = 'FFFFFF';
const BORDER_LIGHT = 'E8C4C4';

function thinBorder(rgb: string) {
  const edge = { style: 'thin' as const, color: { rgb } };
  return { top: edge, bottom: edge, left: edge, right: edge };
}

const styleTitle = {
  fill: { fgColor: { rgb: BRAND_RED_DARK } },
  font: { bold: true, color: { rgb: WHITE }, sz: 13 },
  alignment: { horizontal: 'left' as const, vertical: 'center' as const },
  border: thinBorder(BRAND_RED),
};

const styleHeader = {
  fill: { fgColor: { rgb: BRAND_RED } },
  font: { bold: true, color: { rgb: WHITE }, sz: 11 },
  alignment: { horizontal: 'center' as const, vertical: 'center' as const, wrapText: true },
  border: thinBorder(BRAND_RED_DARK),
};

function styleDataRow(alt: boolean) {
  return {
    fill: { fgColor: { rgb: alt ? ROW_ALT : ROW_WHITE } },
    font: { sz: 10, color: { rgb: TEXT_DARK } },
    alignment: { vertical: 'center' as const, wrapText: true },
    border: thinBorder(BORDER_LIGHT),
  };
}

function padRow(cols: (string | number)[], width: number): (string | number)[] {
  const next = [...cols];
  while (next.length < width) next.push('');
  return next.slice(0, width);
}

function applyRowStyle(ws: XLSX.WorkSheet, r: number, colCount: number, style: Record<string, unknown>) {
  for (let c = 0; c < colCount; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) {
      ws[addr] = { t: 's', v: '' };
    }
    const cell = ws[addr] as XLSX.CellObject;
    cell.s = style as XLSX.CellObject['s'];
  }
}

function buildStyledSectionSheet(title: string, header: string[], dataRows: (string | number)[][]): XLSX.WorkSheet {
  const maxCols = Math.max(header.length, 13);
  const rows: (string | number)[][] = [];
  rows.push(padRow([title], maxCols));
  rows.push(padRow(header, maxCols));
  for (const r of dataRows) rows.push(padRow(r, maxCols));

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const titleRow = 0;
  const hdrRow = 1;
  const dataStart = 2;
  const dataEnd = dataStart + dataRows.length - 1;

  ws['!merges'] = [{ s: { r: titleRow, c: 0 }, e: { r: titleRow, c: maxCols - 1 } }];

  ws['!cols'] = Array.from({ length: maxCols }, (_, i) => {
    if (i === 0) return { wch: 26 };
    if (i === 1 || i === 2) return { wch: 14 };
    if (i === 3) return { wch: 38 };
    return { wch: 14 };
  });

  applyRowStyle(ws, titleRow, maxCols, styleTitle);
  applyRowStyle(ws, hdrRow, maxCols, styleHeader);
  for (let r = dataStart; r <= dataEnd; r++) {
    const alt = (r - dataStart) % 2 === 1;
    for (let c = 0; c < maxCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (!ws[addr]) ws[addr] = { t: 's', v: '' };
      const cell = ws[addr] as XLSX.CellObject;
      cell.s = styleDataRow(alt) as XLSX.CellObject['s'];
    }
  }

  ws['!views'] = [
    {
      ySplit: 2,
      xSplit: 0,
      topLeftCell: XLSX.utils.encode_cell({ r: 2, c: 0 }),
      activeCell: XLSX.utils.encode_cell({ r: 2, c: 0 }),
      showGridLines: true,
    },
  ];

  return ws;
}

/**
 * Libro con dos hojas: Préstamos y Detalle de cuotas. Estilos rojo Yego Rapidín.
 */
export function writeRapidinLoansStyledExcel(
  loanHeader: string[],
  loanData: (string | number)[][],
  instHeader: string[],
  instData: (string | number)[][],
  fileName: string
) {
  const wb = XLSX.utils.book_new();
  const wsLoans = buildStyledSectionSheet('Préstamos — Yego Rapidín', loanHeader, loanData);
  XLSX.utils.book_append_sheet(wb, wsLoans, 'Préstamos');
  const wsInst = buildStyledSectionSheet('Detalle de cuotas', instHeader, instData);
  XLSX.utils.book_append_sheet(wb, wsInst, 'Detalle cuotas');
  XLSX.writeFile(wb, fileName);
}
