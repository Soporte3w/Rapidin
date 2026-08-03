import { mondayOfWeekContainingYmd } from '../../../utils/miautoLimaWeekRange.js';

export class MiautoStartDateCorrectionError extends Error {
  constructor(message, statusCode = 409, code = 'unsafe_start_date_correction') {
    super(message);
    this.name = 'MiautoStartDateCorrectionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeMiautoStartDate(value) {
  const ymd = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    throw new MiautoStartDateCorrectionError(
      'La nueva fecha de inicio de cobro debe tener el formato YYYY-MM-DD',
      400,
      'invalid_start_date',
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new MiautoStartDateCorrectionError(
      'La nueva fecha de inicio de cobro no es una fecha válida',
      400,
      'invalid_start_date',
    );
  }
  return ymd;
}

export function normalizeMiautoStoredStartDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return normalizeMiautoStartDate(value.toISOString().slice(0, 10));
  }
  const raw = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(raw);
  if (match) return normalizeMiautoStartDate(match[1]);
  throw new MiautoStartDateCorrectionError(
    'La fecha actual de inicio de cobro almacenada no es válida',
    500,
    'invalid_stored_start_date',
  );
}

export function buildMiautoStartDateCorrection(currentValue, nextValue) {
  const currentDate = normalizeMiautoStoredStartDate(currentValue);
  const nextDate = normalizeMiautoStartDate(nextValue);
  return {
    currentDate,
    nextDate,
    currentWeekStart: mondayOfWeekContainingYmd(currentDate),
    nextWeekStart: mondayOfWeekContainingYmd(nextDate),
    changed: currentDate !== nextDate,
  };
}

export function assertBootstrapWeeklyQuotaForStartDateCorrection(cuotas, currentWeekStart) {
  if (!Array.isArray(cuotas) || cuotas.length !== 1) {
    throw new MiautoStartDateCorrectionError(
      cuotas?.length > 1
        ? 'No se puede modificar automáticamente porque el contrato ya tiene cuotas posteriores. La fecha se mantuvo sin cambios.'
        : 'No se puede modificar automáticamente porque no se encontró la cuota inicial del contrato.',
    );
  }

  const cuota = cuotas[0];
  const weekStart = String(cuota.week_start_date || '').slice(0, 10);
  const status = String(cuota.status || '').toLowerCase();
  const amountDue = Number(cuota.amount_due || 0);
  const paidAmount = Number(cuota.paid_amount || 0);
  const hasOperationalValues = [
    cuota.num_viajes,
    cuota.partner_fees_raw,
    cuota.partner_fees_83,
    cuota.bono_auto,
    cuota.cobro_saldo,
    cuota.late_fee,
    cuota.mora_extra,
  ].some((value) => Math.abs(Number(value || 0)) > 0.005);

  if (
    weekStart !== currentWeekStart
    || status !== 'paid'
    || Math.abs(amountDue - paidAmount) > 0.005
    || hasOperationalValues
    || cuota.pago_puntual === true
  ) {
    throw new MiautoStartDateCorrectionError(
      'No se puede modificar automáticamente porque la cuota inicial ya tiene actividad financiera. La fecha se mantuvo sin cambios.',
    );
  }
  return cuota;
}
