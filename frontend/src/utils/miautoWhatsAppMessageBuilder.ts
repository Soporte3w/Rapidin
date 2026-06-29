/**
 * Yego Rapidín 4.0 — WhatsApp Message Builder (Mi Auto)
 * Lógica compartida entre rent-sale (envío individual) y mensajes (envío masivo).
 * Mismo código que openWhatsAppModal en YegoMiAutoRentSaleDetail.tsx.
 */
import { symMoneda } from './miautoAlquilerVentaList';
import { miautoSemanaOrdinalPorVencimiento, miautoNum } from './miautoRentSaleHelpers';
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
  late_fee?: number;
  mora_extra?: number;
  mora_pendiente?: number;
  mora_acumulada?: number;
  moneda?: string;
  status?: string;
  saldo_favor_conductor?: number;
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
  return String(c?.moneda || 'PEN').toUpperCase() === 'USD' ? 'USD' : 'PEN';
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
    const cobroDesdeSaldo = Number(cuotaReciente?.cobro_desde_saldo_conductor || 0);
    const cobroSaldoRegla = Number(cuotaReciente?.cobro_saldo || 0);

    let descuentos = '\nDESCUENTOS:\n';
    let hasDescuentos = false;
    if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroSaldoRegla > 0.01) { descuentos += `🔹 Cobro de saldo: ${sym} ${cobroSaldoRegla.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroDesdeSaldo > 0.01) { descuentos += `🔹 Cobro de saldo (Fleet): ${sym} ${cobroDesdeSaldo.toFixed(2)}\n`; hasDescuentos = true; }
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

    const pendientes = cuotasPendientes
      .filter((c) => {
        const pt = Number(c.amount_due || 0) - Number(c.paid_amount || 0)
          + Math.max(Number(c.mora_pendiente ?? 0), Number(c.mora_acumulada ?? c.late_fee ?? 0))
          + miautoNum(c.mora_extra);
        return pt > 0.01;
      })
      .slice(0, 10)
      .map((c) => {
        const s = symMoneda(monedaCuotaRow(c));
        const pendingTotal = Number(c.amount_due || 0) - Number(c.paid_amount || 0)
          + Math.max(Number(c.mora_pendiente ?? 0), Number(c.mora_acumulada ?? c.late_fee ?? 0))
          + miautoNum(c.mora_extra);
        const semana = miautoSemanaOrdinalPorVencimiento(cuotas, c.due_date, c.week_start_date);
        return { semana, sym: s, pendingTotal };
      });
    const mas = cuotasPendientes.length > 10 ? cuotasPendientes.length - 10 : 0;

    const lineasPendientes = pendientes.map((p) => `🔹 Semana ${p.semana}: ${p.sym} ${p.pendingTotal.toFixed(2)} 🚨`);
    descuentos += lineasPendientes.join('\n');
    if (mas > 0) descuentos += `\n🔹 Y ${mas} cuota(s) más... 🚨`;
    defaultText = `${header}${descuentos}\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
  } else if (cuotaReciente) {
    const sym = symMoneda(monedaCuotaRow(cuotaReciente));
    const viajes = cuotaReciente.num_viajes ?? 0;
    const cuotaSemanal = Number(cuotaReciente.cuota_semanal || cuotaReciente.amount_due || 0);
    const pfYangoRaw = Number(cuotaReciente.partner_fees_yango_raw || 0);
    const pf83Real = roundToTwoDecimals(pfYangoRaw * 0.8333);
    const cobroSaldoRegla = Number(cuotaReciente.cobro_saldo || 0);
    const cobroDesdeSaldo = Number(cuotaReciente.cobro_desde_saldo_conductor || 0);
    const saldoFavor = Number(cuotaReciente.saldo_favor_conductor || 0);
    const pagado = Number(cuotaReciente.paid_amount || 0);
    const pendingTotalCuota = Number(cuotaReciente.amount_due || 0) - Number(cuotaReciente.paid_amount || 0)
      + Math.max(Number(cuotaReciente.mora_pendiente ?? 0), Number(cuotaReciente.mora_acumulada ?? cuotaReciente.late_fee ?? 0))
      + miautoNum(cuotaReciente.mora_extra);
    const semana = miautoSemanaOrdinalPorVencimiento(cuotas, cuotaReciente.due_date, cuotaReciente.week_start_date);
    const cubierto = pendingTotalCuota <= 0.01;

    let header = `Hola ${name},\n\nLe compartimos el detalle de su pago:\n- Semana ${semana}: ${viajes} viajes - ${sym} ${cuotaSemanal.toFixed(2)}\n`;

    let descuentos = '\nDESCUENTOS:\n';
    let hasDescuentos = false;
    if (pf83Real > 0.01) { descuentos += `🔹 Cobro por ingresos (83.33%): ${sym} ${pf83Real.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroSaldoRegla > 0.01) { descuentos += `🔹 Cobro de saldo: ${sym} ${cobroSaldoRegla.toFixed(2)}\n`; hasDescuentos = true; }
    if (cobroDesdeSaldo > 0.01) { descuentos += `🔹 Cobro de saldo (Fleet): ${sym} ${cobroDesdeSaldo.toFixed(2)}\n`; hasDescuentos = true; }
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
      let pagadoText = '\n------------------------------------------------------------------------\nPAGADO:\n';
      if (pagado > 0.01) pagadoText += `🔹 Pagado: ${sym} ${pagado.toFixed(2)} ✅\n`;
      pagadoText += '\n🔸 ¡Cuota cubierta! ✅\n';
      if (saldoFavor > 0.01) pagadoText += `\nSaldo a tu favor: ${sym} ${saldoFavor.toFixed(2)} 🎉`;
      defaultText = `${header}${descuentos}${pagadoText}\n\nCualquier consulta quedamos atentos 👍`;
    } else {
      defaultText = `${header}${descuentos}\n------------------------------------------------------------------------\nPENDIENTE:\n🔹 Semana ${semana}: ${sym} ${pendingTotalCuota.toFixed(2)} 🚨\n\nCualquier consulta quedamos atentos 👍\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
    }
  } else {
    defaultText = `Hola ${name},\n\nTe contactamos respecto a tu contrato Yego Mi Auto. Cualquier duda estamos a tu disposición.\n\n${CUENTAS_BANCARIAS_WHATSAPP}`;
  }

  return { fullMessage: defaultText, cuotasMsg: defaultText };
}
