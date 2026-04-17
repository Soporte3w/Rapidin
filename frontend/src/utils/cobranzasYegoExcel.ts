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
  return String(h ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Monto: número, o texto tipo "S/.500.00", "500", "500.5" */
export function parseCobranzasAmount(val: unknown): number {
  if (val == null || val === '') return NaN;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const s = String(val).trim();
  if (!s) return NaN;
  const noCurrency = s.replace(/^S\/\.?\s*/i, '').trim();
  const n = parseFloat(noCurrency.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Fecha DD/MM/YYYY (formato Excel PE al exportar con raw:false) */
export function parsePeDateToYmd(val: unknown): string | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    const d = XLSX.SSF.parse_date_code(val);
    if (!d) return null;
    const mm = String(d.m).padStart(2, '0');
    const dd = String(d.d).padStart(2, '0');
    return `${d.y}-${mm}-${dd}`;
  }
  const s = String(val).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Archivo tipo "Archivo cobranzas YEGO.xlsx": una hoja por semana.
 * Columnas: driver_id (Yango), Fecha, columna "Cobro (lunes …)" con el monto, Comentarios opcional.
 */
export function parseCobranzasYegoWorkbook(
  wb: { SheetNames: string[]; Sheets: Record<string, unknown> },
  sheetNamesFilter?: Set<string>
): {
  rows: CobranzasExcelRow[];
  warnings: string[];
} {
  const rows: CobranzasExcelRow[] = [];
  const warnings: string[] = [];

  for (const sheetName of wb.SheetNames) {
    if (sheetNamesFilter && sheetNamesFilter.size > 0 && !sheetNamesFilter.has(sheetName)) continue;
    const sh = wb.Sheets[sheetName];
    if (!sh) continue;
    const matrix = XLSX.utils.sheet_to_json<(string | number)[]>(sh, {
      header: 1,
      defval: '',
      raw: false,
    });
    if (!matrix.length) {
      warnings.push(`Hoja "${sheetName}": vacía.`);
      continue;
    }
    const headers = (matrix[0] || []).map(normHeader);
    const idxDriver = headers.findIndex((h) => h.toLowerCase() === 'driver_id');
    const idxFecha = headers.findIndex((h) => h.toLowerCase() === 'fecha');
    const idxLunes = headers.findIndex((h) => /^Cobro\s*\(lunes/i.test(h));
    const idxComments = headers.findIndex((h) => h.toLowerCase() === 'comentarios');
    const idxConductor = headers.findIndex((h) => h.toLowerCase() === 'conductor');

    if (idxDriver < 0 || idxFecha < 0 || idxLunes < 0) {
      warnings.push(
        `Hoja "${sheetName}": faltan columnas esperadas (driver_id, Fecha, Cobro (lunes…)). Se omite.`
      );
      continue;
    }

    for (let r = 1; r < matrix.length; r++) {
      const line = matrix[r];
      if (!line || !line.length) continue;
      const ext = String(line[idxDriver] ?? '').trim().toLowerCase();
      if (!ext || !/^[0-9a-f]{32}$/i.test(ext.replace(/-/g, ''))) {
        const raw = String(line[idxDriver] ?? '').trim();
        if (raw) warnings.push(`Hoja "${sheetName}" fila ${r + 1}: driver_id no válido (${raw.slice(0, 12)}…).`);
        continue;
      }
      const normalizedExt = ext.replace(/-/g, '');
      const amount = parseCobranzasAmount(line[idxLunes]);
      const payment_date = parsePeDateToYmd(line[idxFecha]);
      const conductor =
        idxConductor >= 0 ? String(line[idxConductor] ?? '').trim() || undefined : undefined;
      const comments = idxComments >= 0 ? String(line[idxComments] ?? '').trim() : '';

      if (!payment_date) {
        warnings.push(`Hoja "${sheetName}" fila ${r + 1}: fecha inválida.`);
        continue;
      }
      if (!Number.isFinite(amount) || amount < 0.01) continue;

      const obsParts = [`Cobranzas YEGO`, sheetName];
      if (conductor) obsParts.push(conductor);
      if (comments && comments !== '-') obsParts.push(comments);
      rows.push({
        external_driver_id: normalizedExt,
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
): Promise<{
  rows: CobranzasExcelRow[];
  warnings: string[];
  sheetNames: string[];
}> {
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
