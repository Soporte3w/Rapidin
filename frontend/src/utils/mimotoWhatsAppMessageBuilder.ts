import { formatMimotoMoney, type MimotoDetail, type MimotoQuota } from '../pages/yegoMiMoto/mimotoApi';

function numeric(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function quotaDate(quota: MimotoQuota) {
  return new Date(`${quota.week_start_date || quota.due_date}T12:00:00`).getTime();
}

function relevantQuota(quotas: MimotoQuota[]) {
  const ordered = [...quotas].sort((left, right) => quotaDate(right) - quotaDate(left));
  return ordered.find((quota) => ['overdue', 'partial', 'pending'].includes(quota.status)) || ordered[0];
}

export function buildMiMotoMessage(detail: MimotoDetail) {
  const driverName = `${detail.first_name || ''} ${detail.last_name || ''}`.trim() || 'Conductor';
  const quotas = Array.isArray(detail.cuotas) ? detail.cuotas : [];
  const quota = relevantQuota(quotas);

  if (!quota) {
    return `Hola ${driverName},\n\nAún no tienes una cuota semanal generada en Yego Mi Moto.\n\nCualquier consulta, quedamos atentos.`;
  }

  const currency = quota.moneda || detail.vehiculo_moneda || 'COP';
  const overdueCount = quotas.filter((item) => item.status === 'overdue' && numeric(item.saldo_total) > 0).length;
  const lines = [
    `Hola ${driverName},`,
    '',
    `Resumen de la semana ${quota.week_number}:`,
    `- Viajes realizados: ${numeric(quota.viajes)}`,
  ];

  if (detail.modo_evaluacion === 'viajes_horas') {
    lines.push(`- Horas conectadas: ${numeric(quota.horas_conectadas).toLocaleString('es-CO', { maximumFractionDigits: 2 })} h`);
  }

  lines.push(
    `- Cuota contractual: ${formatMimotoMoney(quota.cuota_semanal, currency)}`,
    `- Bono moto: ${formatMimotoMoney(quota.bono_moto, currency)}`,
    `- Recaudo aplicado: ${formatMimotoMoney(quota.recaudo_aplicado, currency)}`,
    `- Cobro saldo: ${formatMimotoMoney(quota.cobro_saldo, currency)}`,
    `- Saldo pendiente: ${formatMimotoMoney(quota.saldo_total, currency)}`,
  );

  if (overdueCount > 0) {
    lines.push(`- Cuotas vencidas con saldo: ${overdueCount}`);
  }

  lines.push('', numeric(quota.saldo_total) <= 0 ? '¡Cuota cubierta! ✅' : 'Sigue sumando viajes y horas esta semana.', '', 'Cualquier consulta, quedamos atentos.');
  return lines.join('\n');
}
