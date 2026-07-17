import {
  listForAdminValidation as listWeeklyReceipts,
} from './miautoComprobanteCuotaSemanalService.js';
import {
  listForAdminValidation as listOtherExpenseReceipts,
} from './miautoComprobanteOtrosGastosService.js';

const STATUS_PRIORITY = { pendiente: 0, validado: 1, rechazado: 2 };

function statusPriority(row) {
  return STATUS_PRIORITY[String(row.estado || 'pendiente').toLowerCase()] ?? 4;
}

export async function listComprobantesForAdminValidation(options = {}) {
  const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 300));
  const queryOptions = { ...options, limit };
  const [weekly, otherExpenses] = await Promise.all([
    listWeeklyReceipts(queryOptions),
    listOtherExpenseReceipts(queryOptions),
  ]);

  return [...weekly, ...otherExpenses]
    .sort((a, b) => {
      const statusDifference = statusPriority(a) - statusPriority(b);
      if (statusDifference !== 0) return statusDifference;
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    })
    .slice(0, limit);
}
