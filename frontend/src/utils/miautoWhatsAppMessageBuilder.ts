/**
 * Yego Rapidín 4.0 — WhatsApp Message Builder (Mi Auto)
 * Lógica compartida entre rent-sale (envío individual) y mensajes (envío masivo).
 * Mismo código que openWhatsAppModal en YegoMiAutoRentSaleDetail.tsx.
 */
import { symMoneda } from './miautoAlquilerVentaList';
import {
  miautoCobroSaldoDisplay,
  miautoCuotaFinalCronogramaSemanal,
  miautoNum,
  miautoSemanaOrdinalPorVencimiento,
} from './miautoRentSaleHelpers';
import { roundToTwoDecimals } from './currency';
import { CUENTAS_BANCARIAS_WHATSAPP } from '../pages/yegoRapidin/LoanDetail';

// ── Tipos ──
interface CuotaRow {
  week_start_date?: string;
  due_date?: string;
  num_viajes?: number;
  cuota_semanal?: number;
  amount_due?: number;
  paid_amount?: number;
  amount_due_sched?: number;
  cuota_pendiente?: number;
  cuota_final?: number;
  late_fee?: number;
  mora_extra?: number;
  mora_extra_total?: number;
  mora_extra_cobrada?: number;
  mora_pendiente?: number;
  mora_acumulada?: number;
  moneda?: string;
  status?: string;
  cobro_saldo?: number;
  cobro_desde_saldo_conductor?: number;
  partner_fees_yango_raw?: number;
  partner_fees_cascada_aplicado_a?: Array<{
    cuota_semanal_id?: string;
    week_start_date?: string | null;
    monto: number;
  }>;
  pending_total?: number;
}

export interface BuildMessageInput {
  driverName: string;
  cuotas: CuotaRow[];
}

export interface BuildMessageResult {
  fullMessage: string;
  cuotasMsg: string;
}

// ── Helpers ──
function monedaCuotaRow(c: Pick<CuotaRow, 'moneda'>) {
  const u = String(c?.moneda || 'PEN').toUpperCase();
  if (u === 'USD' || u === 'COP') return u;
  return 'PEN';
}

function cuotaPendienteWhatsApp(c: CuotaRow): number {
  return roundToTwoDecimals(Math.max(0, miautoCuotaFinalCronogramaSemanal(c)));
}

function moraPendienteWhatsApp(c: CuotaRow): number {
  return roundToTwoDecimals(Math.max(0, miautoNum(c.mora_pendiente ?? c.late_fee ?? 0)));
}

function moraExtraWhatsApp(c: CuotaRow): number {
  return roundToTwoDecimals(Math.max(0, miautoNum(c.mora_extra ?? 0)));
}

function lineSuffixMora(sym: string, c: CuotaRow): string {
  const mora = moraPendienteWhatsApp(c);
  const moraExtra = moraExtraWhatsApp(c);
  const parts: string[] = [];
  if (mora > 0.01) parts.push(`mora ${sym} ${mora.toFixed(2)}`);
  if (moraExtra > 0.01) parts.push(`mora extra ${sym} ${moraExtra.toFixed(2)}`);
  return parts.length ? ` (incluye ${parts.join(' + ')})` : '';
}

/**
 * Construye el mensaje de WhatsApp para un conductor.
 * Misma lógica que openWhatsAppModal en YegoMiAutoRentSaleDetail.tsx (líneas 322-417).
 */
export function buildMiAutoMessage(input: BuildMessageInput): BuildMessageResult {
  const { driverName, cuotas } = input;
  const name = driverName || 'Conductor';

  const cuotaReciente = [...cuotas]
    .sort((a, b) => String(b.week_start_date || '').localeCompare(String(a.week_start_date || '')))
    [0];

  const overdueCuotas = cuotas.filter((c) => c.status === 'overdue');
  const cuotasPendientes = cuotas.filter((c) => c.status !== 'paid' && c.status !== 'bonificada');

  let defaultText: string;

  if (overdueCuotas.length > 0) {
    const sym = cuotaReciente ? symMoneda(monedaCuotaRow(cuotaReciente)) : 'S/';
    const viajes = cuotaReciente?.num_viajes ?? 0;
    const cuotaSemanal = Number(cuotaReciente?.cuota_semanal || 0);

    let header = `Hola ${name},\n\nLe compartimos el detalle de su pago:\n`;
    if (cuotaReciente) {
      header += `- Semana ${miautoSemanaOrdinalPorVencimiento(cuotas, cuotaReciente.due_date, cuotaReciente.week_start_date)}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;
    }

    const pfYangoRaw = Number(cuotaReciente?.partner_fees_yango_raw || 0);
    const pf83Real = pfYangoRaw > 0.01 ? roundToTwoDecimals(pfYangoRaw * 0.8333) : 0;
    const cobroSaldoApp = miautoCobroSaldoDisplay(cuotaReciente || {});

    let descuentos = '\nDESCUENTOS:\n';
    let hasDescuentos = false;
    if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroSaldoApp > 0.01) { descuentos += `🔹 Cobro saldo del app: ${sym} ${cobroSaldoApp.toFixed(2)}\n`; hasDescuentos = true; }
    if (!hasDescuentos) descuentos += '🔹 Sin descuentos esta semana\n';

    const cascadaRef = cuotaReciente?.partner_fees_cascada_aplicado_a;
    if (Array.isArray(cascadaRef) && cascadaRef.length > 0) {
      descuentos += '\n📌 Cobro aplicado a otras semanas:\n';
      cascadaRef.forEach((ref: any) => {
        const sem = miautoSemanaOrdinalPorVencimiento(cuotas, ref.week_start_date, ref.week_start_date);
        descuentos += `   → Semana ${sem}: ${sym} ${Number(ref.monto).toFixed(2)}\n`;
      });
    }

    descuentos += '\n------------------------------------------------------------------------\nPENDIENTE:\n';

    const cuotasPendientesConSaldo = cuotasPendientes.filter((c) => cuotaPendienteWhatsApp(c) > 0.01);
    const pendientes = cuotasPendientesConSaldo
      .slice(0, 10)
      .map((c) => {
        const s = symMoneda(monedaCuotaRow(c));
        const pendingTotal = cuotaPendienteWhatsApp(c);
        const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
        return { semana, sym: s, pendingTotal, moraDetalle: lineSuffixMora(s, c) };
      });
    const mas = cuotasPendientesConSaldo.length > 10 ? cuotasPendientesConSaldo.length - 10 : 0;

    const lineasPendientes = pendientes.map((p) => `🔹 Semana ${p.semana}: ${p.sym} ${p.pendingTotal.toFixed(2)}${p.moraDetalle} 🚨`);
    descuentos += lineasPendientes.join('\n');
    if (mas > 0) descuentos += `\n🔹 Y ${mas} cuota(s) más... 🚨`;
    defaultText = `${header}${descuentos}\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
  } else if (cuotaReciente) {
    const sym = symMoneda(monedaCuotaRow(cuotaReciente));
    const viajes = cuotaReciente.num_viajes ?? 0;
    const cuotaSemanal = Number(cuotaReciente.cuota_semanal || cuotaReciente.amount_due || 0);
    const pfYangoRaw = Number(cuotaReciente.partner_fees_yango_raw || 0);
    const pf83Real = roundToTwoDecimals(pfYangoRaw * 0.8333);
    const cobroSaldoApp = miautoCobroSaldoDisplay(cuotaReciente);
    const pendingTotalCuota = cuotaPendienteWhatsApp(cuotaReciente);
    const semana = miautoSemanaOrdinalPorVencimiento(cuotas, cuotaReciente.due_date, cuotaReciente.week_start_date);
    const cubierto = pendingTotalCuota <= 0.01;

    let header = `Hola ${name},\n\nLe compartimos el detalle de su pago:\n- Semana ${semana}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;

    let descuentos = '\nDESCUENTOS:\n';
    let hasDescuentos = false;
    if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroSaldoApp > 0.01) { descuentos += `🔹 Cobro saldo del app: ${sym} ${cobroSaldoApp.toFixed(2)}\n`; hasDescuentos = true; }
    if (!hasDescuentos) descuentos += '🔹 Sin descuentos esta semana\n';

    const cascadaRefSingle = cuotaReciente?.partner_fees_cascada_aplicado_a;
    if (Array.isArray(cascadaRefSingle) && cascadaRefSingle.length > 0) {
      descuentos += '\n📌 Cobro aplicado a otras semanas:\n';
      cascadaRefSingle.forEach((ref: any) => {
        const sem = miautoSemanaOrdinalPorVencimiento(cuotas, ref.week_start_date, ref.week_start_date);
        descuentos += `   → Semana ${sem}: ${sym} ${Number(ref.monto).toFixed(2)}\n`;
      });
    }

    if (cubierto) {
      defaultText = `${header}${descuentos}\n------------------------------------------------------------------------\n\n🔸 ¡Cuota cubierta! ✅\n\nCualquier consulta quedamos atentos 👍`;
    } else {
      defaultText = `${header}${descuentos}\n------------------------------------------------------------------------\nPENDIENTE:\n🔹 Semana ${semana}: ${sym} ${pendingTotalCuota.toFixed(2)}${lineSuffixMora(sym, cuotaReciente)} 🚨\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    }
  } else {
    defaultText = `Hola ${name},\n\nTe contactamos respecto a tu contrato Yego Mi Auto. Cualquier duda estamos a tu disposición.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
  }

  return { fullMessage: defaultText, cuotasMsg: defaultText };
}
