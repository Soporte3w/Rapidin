import path from 'node:path';
import XLSX from 'xlsx';

const SOURCE_SHEET = '5.Pagos Semanales Registro';
const FIRST_DATA_ROW = 3;
const FIRST_QUOTA_COLUMN = 12;
const QUOTA_BLOCK_SIZE = 6;

const KNOWN_WEEKLY_AMOUNTS = new Set([
  94000, 97000, 100000, 105000, 107000, 110000, 111000, 113000, 123000,
  125000, 126600, 127000, 128000, 132000, 138000, 139500, 140000, 141600,
  145000, 146000, 147000, 150000, 151600, 153000, 155000, 156600, 160000,
  161000, 162000, 165000, 166000, 166600, 170000, 171000, 180000, 181600,
  187000, 192000,
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cellValue(sheet, row, column) {
  return sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })]?.v ?? null;
}

function cellDisplayValue(sheet, row, column) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
  return cell?.w ?? cell?.v ?? null;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = clean(value).replace(/[$\s]/g, '');
  if (!text) return null;
  if (/^-?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (text.includes(',') && !text.includes('.')) {
    text = text.replace(',', '.');
  } else {
    text = text.replace(/,/g, '');
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMoney(value, { weekly = false } = {}) {
  const parsed = parseNumber(value);
  if (parsed == null || parsed <= 0) return { amount: null, corrected: false };
  if (parsed >= 1000) return { amount: Math.round(parsed * 100) / 100, corrected: false };
  const expanded = Math.round(parsed * 1000 * 100) / 100;
  const canExpand = weekly ? KNOWN_WEEKLY_AMOUNTS.has(expanded) : expanded === 500000;
  return canExpand
    ? { amount: expanded, corrected: true }
    : { amount: Math.round(parsed * 100) / 100, corrected: false };
}

function validYmd(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { date: value.toISOString().slice(0, 10), malformed: false };
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? { date: validYmd(parsed.y, parsed.m, parsed.d), malformed: false } : { date: null, malformed: true };
  }

  const raw = clean(value);
  if (!raw) return { date: null, malformed: false };
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return { date: validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3])), malformed: false };

  const compact = raw.replace(/-/g, '/');
  let parts = compact.match(/^(\d{1,2})\/(\d{1,3})\/(\d{2,4})$/);
  if (!parts) parts = compact.match(/^(\d{1,2})\/(\d{2})(\d{4})$/);
  if (!parts) return { date: null, malformed: true };

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  const yearText = parts[3];
  let year = Number(yearText);
  if (yearText.length === 2) year += 2000;
  if (yearText === '0206') year = 2026;
  return { date: validYmd(year, month, day), malformed: true };
}

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left, right) {
  return Math.round((new Date(`${right}T00:00:00Z`) - new Date(`${left}T00:00:00Z`)) / 86400000);
}

function repairSequenceDates(quotas, warnings) {
  for (let index = 0; index < quotas.length; index += 1) {
    const quota = quotas[index];
    const previous = quotas[index - 1];
    const next = quotas[index + 1];
    let expected = null;
    if (previous?.date && next?.date && daysBetween(previous.date, next.date) === 14) {
      expected = addDays(previous.date, 7);
    } else if (quota.dateMalformed && !previous?.date && next?.date) {
      expected = addDays(next.date, -7);
    } else if (quota.dateMalformed && previous?.date && !next?.date) {
      expected = addDays(previous.date, 7);
    }

    const isLargeOutlier = expected && quota.date && Math.abs(daysBetween(expected, quota.date)) > 21;
    if (expected && (!quota.date || quota.dateMalformed || isLargeOutlier) && quota.date !== expected) {
      warnings.push({
        type: 'date_repaired_from_sequence',
        quota: quota.number,
        from: quota.dateRaw,
        to: expected,
      });
      quota.date = expected;
    }
  }
}

function parseIdentityAndPhone(value) {
  const raw = clean(value).toUpperCase();
  const documentMatch = raw.match(/COL\s*(\d{6,12})/) || raw.match(/\bV\s*(\d{6,12})/);
  const documentType = documentMatch?.[0].trim().startsWith('V') ? 'CE' : 'CC';
  const digitGroups = raw.match(/\d+/g) || [];
  let phone = null;
  for (let index = 0; index < digitGroups.length; index += 1) {
    let digits = digitGroups[index];
    if (digits.length === 2 && digits === '57' && digitGroups[index + 1]?.length === 10) {
      digits += digitGroups[index + 1];
    }
    if (digits.length === 12 && digits.startsWith('57') && digits[2] === '3') {
      phone = digits;
      break;
    }
    if (digits.length === 10 && digits.startsWith('3')) {
      phone = `57${digits}`;
      break;
    }
  }
  return {
    raw,
    documentType,
    documentNumber: documentMatch?.[1] || null,
    phone,
  };
}

function parseTripsAndHours(value) {
  const raw = clean(value);
  if (!raw || raw === '-') {
    return { raw, trips: 0, observedHours: null, recognized: true };
  }

  if (/^\d+$/.test(raw)) {
    return { raw, trips: Number(raw), observedHours: null, recognized: true };
  }

  const withoutAnnotation = raw.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const combined = withoutAnnotation.match(/^(\d+)\s*-\s*(.+)$/);
  if (!combined) {
    return { raw, trips: 0, observedHours: null, recognized: false };
  }

  const trips = Number(combined[1]);
  const hoursText = combined[2].trim().toLowerCase();
  const hoursAndMinutes = hoursText.match(/^(\d+):(\d{1,2})\s*h?$/);
  if (hoursAndMinutes && Number(hoursAndMinutes[2]) < 60) {
    const observedHours = Number(hoursAndMinutes[1]) + (Number(hoursAndMinutes[2]) / 60);
    return { raw, trips, observedHours, recognized: true };
  }

  const minutes = hoursText.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|min|minutos?)$/);
  if (minutes) {
    return {
      raw,
      trips,
      observedHours: Number(minutes[1].replace(',', '.')) / 60,
      recognized: true,
    };
  }

  const hours = hoursText.match(/^(\d+(?:[.,]\d+)?)\s*(?:h|horas?)?$/);
  if (hours) {
    return {
      raw,
      trips,
      observedHours: Number(hours[1].replace(',', '.')),
      recognized: true,
    };
  }

  return { raw, trips: 0, observedHours: null, recognized: false };
}

function splitName(value) {
  const parts = clean(value).split(' ').filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || 'Sin nombre', lastName: 'Sin apellido' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function parseQuota(sheet, row, column, number, warnings) {
  const dateRaw = cellValue(sheet, row, column);
  // Use the displayed value because Excel may auto-convert entries such as
  // "05-01" (5 trips, 1 hour) into a date serial internally.
  const tripHoursRaw = cellDisplayValue(sheet, row, column + 1);
  const amountRaw = cellValue(sheet, row, column + 2);
  const sourceRaw = clean(cellValue(sheet, row, column + 3));
  const fileRaw = clean(cellValue(sheet, row, column + 4));
  const validationRaw = clean(cellValue(sheet, row, column + 5));
  if ([dateRaw, tripHoursRaw, amountRaw, sourceRaw, fileRaw, validationRaw].every((item) => clean(item) === '')) return null;

  const parsedDate = parseDate(dateRaw);
  const parsedMoney = normalizeMoney(amountRaw, { weekly: true });
  const tripHours = parseTripsAndHours(tripHoursRaw);
  if (!tripHours.recognized) {
    warnings.push({ type: 'unrecognized_trips_hours', quota: number, value: tripHours.raw });
  }
  if (parsedMoney.corrected) {
    warnings.push({ type: 'short_weekly_amount_expanded', quota: number, from: amountRaw, to: parsedMoney.amount });
  }
  return {
    number,
    date: parsedDate.date,
    dateRaw: clean(dateRaw),
    dateMalformed: parsedDate.malformed,
    amount: parsedMoney.amount,
    amountRaw: clean(amountRaw),
    trips: tripHours.trips,
    observedHours: tripHours.observedHours,
    tripHoursRaw: tripHours.raw,
    sourceRaw,
    fileRaw,
    validationRaw,
    validation: validationRaw.includes('✔') ? 'paid' : validationRaw.includes('❌') ? 'rejected' : 'blank',
  };
}

export function parseMimotoWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheet = workbook.Sheets[SOURCE_SHEET];
  if (!sheet) throw new Error(`No existe la hoja requerida: ${SOURCE_SHEET}`);
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const drivers = [];

  for (let row = FIRST_DATA_ROW; row <= range.e.r + 1; row += 1) {
    const schedule = clean(cellValue(sheet, row, 2));
    const fullName = clean(cellValue(sheet, row, 5));
    if (!/^Cronograma [1-4]$/.test(schedule) || !fullName) continue;

    const warnings = [];
    const initial = normalizeMoney(cellValue(sheet, row, 1));
    if (initial.corrected) warnings.push({ type: 'short_initial_expanded', from: cellValue(sheet, row, 1), to: initial.amount });
    const identity = parseIdentityAndPhone(cellValue(sheet, row, 6));
    const delivery = parseDate(cellValue(sheet, row, 3));
    const quotas = [];
    let quotaNumber = 1;
    for (let column = FIRST_QUOTA_COLUMN; column <= range.e.c + 1; column += QUOTA_BLOCK_SIZE) {
      const quota = parseQuota(sheet, row, column, quotaNumber, warnings);
      if (quota) quotas.push(quota);
      quotaNumber += 1;
    }
    repairSequenceDates(quotas, warnings);

    const seenDates = new Set();
    for (const quota of quotas) {
      if (!quota.date || !quota.amount) {
        quota.skipReason = !quota.date ? 'invalid_or_missing_date' : 'invalid_or_missing_amount';
      } else if (seenDates.has(quota.date)) {
        quota.skipReason = 'duplicate_date_for_driver';
      } else {
        seenDates.add(quota.date);
      }
    }

    drivers.push({
      sourceRow: row,
      schedule,
      fullName,
      ...splitName(fullName),
      city: clean(cellValue(sheet, row, 4)),
      deliveryDate: delivery.date,
      initialAmount: initial.amount,
      identity,
      driverId: clean(cellValue(sheet, row, 7)) || null,
      parkId: clean(cellValue(sheet, row, 8)) || null,
      vehicle: clean(cellValue(sheet, row, 9)),
      quotas,
      warnings,
    });
  }

  return {
    fileName: path.basename(filePath),
    sheetName: SOURCE_SHEET,
    drivers,
  };
}

export const mimotoExcelImportParserInternals = {
  normalizeMoney,
  parseDate,
  parseIdentityAndPhone,
  parseTripsAndHours,
  repairSequenceDates,
};
