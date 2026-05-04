import XLSX from 'xlsx-js-style';

export type CobranzasExcelRow = {
  external_driver_id: string;
  amount: number;
  payment_date: string;
  observations?: string;
  sheet_name: string;
  row_in_sheet: number;
  conductor?: string;
};

function normHeader(h: unknown): string {
  return String(h ?? '').trim().replace(/\s+/g, ' ');
}

export function parseCobranzasAmount(val: unknown): number {
  if (val == null || val === '') return NaN;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const s = String(val).trim();
  if (!s) return NaN;
  const n = parseFloat(s.replace(/^S\/\.?\s*/i, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const MESES: Record<string, string> = {
  ene: '01', enero: '01',
  feb: '02', febrero: '02',
  mar: '03', marzo: '03',
  abr: '04', abril: '04',
  may: '05', mayo: '05',
  jun: '06', junio: '06',
  jul: '07', julio: '07',
  ago: '08', agosto: '08',
  sep: '09', sept: '09', septiembre: '09', set: '09', setiembre: '09',
  oct: '10', octubre: '10',
  nov: '11', noviembre: '11',
  dic: '12', diciembre: '12',
};

function mesTokenToNum(token: string): string | null {
  const key = token.toLowerCase().replace(/\.$/, '');
  return MESES[key] ?? null;
}

/**
 * Fecha de pago derivada del nombre de la hoja: **siempre el primer día del rango**
 * que escribe YEGO/cobranzas (inicio del periodo de esa hoja), no el último día.
 *
 * Ejemplos:
 * - "Sem del 13 al 19 abril" → 13 de abril
 * - "Sem 27 abr al 3 mayo" → 27 de abril
 *
 * No se recalcula “semana ISO” (lunes–domingo); lo que cuenta es el texto del rango en el Excel.
 */
function parseDateFromSheetName(sheetName: string): string | null {
  const año = () => String(new Date().getFullYear());

  // "Sem 27 abr al 3 mayo", "Sem del 27 abr al 3 mayo", "del 27 abril al 3 mayo" → primer día + primer mes
  const mRangoDosMeses =
    /(?:sem(?:ana)?(?:\s+del)?\s+|del\s+)?(\d{1,2})\s+([a-záéíóú]+)\s+al\s+\d{1,2}\s+([a-záéíóú]+)(?:\s+(\d{4}))?/i.exec(
      sheetName
    );
  if (mRangoDosMeses) {
    const mesIni = mesTokenToNum(mRangoDosMeses[2]);
    if (mesIni) return `${mRangoDosMeses[4] || año()}-${mesIni}-${mRangoDosMeses[1].padStart(2, '0')}`;
  }

  // "13 al 19 abril", "del 13 al 19 abril" → primer día del rango + mes indicado al final
  const m = /(\d{1,2})\s+al\s+\d{1,2}\s+(?:de\s+)?([a-záéíóú]+)(?:\s+(\d{4}))?/i.exec(sheetName);
  if (!m) return null;
  const mes = mesTokenToNum(m[2]);
  if (!mes) return null;
  return `${m[3] || año()}-${mes}-${m[1].padStart(2, '0')}`;
}

/**
 * Estructura fija del Excel "Archivo cobranzas YEGO":
 *   Col 0: N°  |  Col 1: driver_id  |  Col 2: Conductor  |  Col 3: Licencia
 *   Col 4: Celular  |  Col 5: Scoring  |  Col 6: Cobro (monto)
 *   Col 7: Cobro YEGO  |  Col 8: Abono YEGO a ANTICIPA  |  Col 9: Notas
 *
 * La fecha de pago es **el primer día del rango** en el nombre de la hoja (ver `parseDateFromSheetName`).
 */
export function parseCobranzasYegoWorkbook(
  wb: { SheetNames: string[]; Sheets: Record<string, unknown> },
  sheetNamesFilter?: Set<string>
): { rows: CobranzasExcelRow[]; warnings: string[] } {
  const rows: CobranzasExcelRow[] = [];
  const warnings: string[] = [];

  for (const sheetName of wb.SheetNames) {
    if (sheetNamesFilter && sheetNamesFilter.size > 0 && !sheetNamesFilter.has(sheetName)) continue;
    const sh = wb.Sheets[sheetName];
    if (!sh) continue;

    const matrix = XLSX.utils.sheet_to_json<(string | number)[]>(sh, { header: 1, defval: '', raw: false });
    if (!matrix.length) { warnings.push(`Hoja "${sheetName}": vacía.`); continue; }

    const payment_date = parseDateFromSheetName(sheetName);
    if (!payment_date) {
      warnings.push(`Hoja "${sheetName}": no se pudo extraer la fecha del nombre de hoja. Se omite.`);
      continue;
    }

    const headers = (matrix[0] || []).map(normHeader);
    const idxDriver    = headers.findIndex((h) => h.toLowerCase() === 'driver_id');
    const idxConductor = headers.findIndex((h) => h.toLowerCase() === 'conductor');
    const idxCobro     = headers.findIndex((h) => /^cobro$/i.test(h));
    const idxAbono     = headers.findIndex((h) => /abono yego/i.test(h));
    const idxNotes     = idxAbono >= 0 ? idxAbono + 1 : -1;

    if (idxDriver < 0 || idxCobro < 0) {
      warnings.push(`Hoja "${sheetName}": faltan columnas driver_id o Cobro. Se omite.`);
      continue;
    }

    for (let r = 1; r < matrix.length; r++) {
      const line = matrix[r];
      if (!line?.length) continue;

      const ext = String(line[idxDriver] ?? '').trim().toLowerCase().replace(/-/g, '');
      if (!ext || !/^[0-9a-f]{32}$/.test(ext)) {
        const raw = String(line[idxDriver] ?? '').trim();
        if (raw) warnings.push(`Hoja "${sheetName}" fila ${r + 1}: driver_id no válido (${raw.slice(0, 12)}…).`);
        continue;
      }

      const amount = parseCobranzasAmount(line[idxCobro]);
      if (!Number.isFinite(amount) || amount < 0.01) continue;

      const conductor = idxConductor >= 0 ? String(line[idxConductor] ?? '').trim() || undefined : undefined;
      const notes     = idxNotes >= 0 ? String(line[idxNotes] ?? '').trim() : '';

      const obsParts = ['Cobranzas YEGO', sheetName];
      if (conductor) obsParts.push(conductor);
      if (notes && notes !== '-') obsParts.push(notes);

      rows.push({
        external_driver_id: ext,
        amount,
        payment_date,
        observations: obsParts.join(' · ').slice(0, 2000),
        sheet_name: sheetName,
        row_in_sheet: r + 1,
        conductor,
      });
    }
  }

  return { rows, warnings };
}

export function readCobranzasYegoFile(
  file: File,
  sheetNamesFilter?: Set<string>
): Promise<{ rows: CobranzasExcelRow[]; warnings: string[]; sheetNames: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const { rows, warnings } = parseCobranzasYegoWorkbook(wb, sheetNamesFilter);
        resolve({ rows, warnings, sheetNames: wb.SheetNames });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
    reader.readAsArrayBuffer(file);
  });
}
