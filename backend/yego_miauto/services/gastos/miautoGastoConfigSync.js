function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function splitTotalInstallment(total, count, installmentNumber) {
  const totalCents = Math.round(Number(total) * 100);
  const baseCents = Math.floor(totalCents / count);
  const remainder = totalCents - baseCents * count;
  return (baseCents + (installmentNumber <= remainder ? 1 : 0)) / 100;
}

export function parseExpenseRequirements(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Devuelve el monto configurado para una cuota existente sin alterar su calendario. */
export function configuredExpenseAmount(requirementsValue, expense) {
  const requirements = parseExpenseRequirements(requirementsValue);
  const concept = String(expense?.tipo || '').trim().toLowerCase();
  const installmentNumber = positiveInteger(expense?.numero_cuota) || 1;

  if (concept === 'gps') return positiveNumber(requirements.gps?.monto);
  if (concept === 'soat') {
    const total = positiveNumber(requirements.soat?.monto);
    const configuredCount = positiveInteger(requirements.soat?.cobro?.meses_anticipo);
    const existingCount = positiveInteger(expense?.total_cuotas);
    const count = existingCount || configuredCount;
    if (!total || !count || installmentNumber > count) return null;
    return splitTotalInstallment(total, count, installmentNumber);
  }
  if (concept === 'src') return positiveNumber(requirements.src?.monto);
  if (concept === 'inicial_parcial') return positiveNumber(requirements.inicial_parcial?.monto);
  if (concept === 'str_gps' || concept === 'todo_riesgo_mas_gps_agrupado') {
    return positiveNumber(requirements.todo_riesgo_mas_gps_agrupado?.monto);
  }
  if (concept === 'impuesto_vehicular') {
    const total = positiveNumber(requirements.impuesto_vehicular?.monto);
    const existingCount = positiveInteger(expense?.total_cuotas);
    const configuredCount = positiveInteger(requirements.impuesto_vehicular?.cobro?.cuotas);
    const count = existingCount || configuredCount;
    if (!total || !count || installmentNumber > count) return null;
    return splitTotalInstallment(total, count, installmentNumber);
  }
  return null;
}

export function amountChanged(currentAmount, configuredAmount) {
  if (configuredAmount == null) return false;
  return Math.abs(round2(currentAmount) - round2(configuredAmount)) > 0.005;
}
