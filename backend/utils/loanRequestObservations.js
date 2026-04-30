export function parseRequestObservations(raw) {
  if (raw == null || raw === '') return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
    return {};
  } catch {
    return {};
  }
}

/** Semanas del plan en solicitud creada por admin (`createdByAdmin`). */
export function resolveAdminLoanWeeks(obs) {
  if (!obs || obs.createdByAdmin !== true) return null;
  const fromPlan = obs.admin_selected_option?.weeks;
  if (fromPlan != null && fromPlan !== '') {
    const w = parseInt(fromPlan, 10);
    if (!Number.isNaN(w) && w >= 1) return w;
  }
  if (obs.number_of_weeks != null && obs.number_of_weeks !== '') {
    const w = parseInt(obs.number_of_weeks, 10);
    if (!Number.isNaN(w) && w >= 1) return w;
  }
  return null;
}
