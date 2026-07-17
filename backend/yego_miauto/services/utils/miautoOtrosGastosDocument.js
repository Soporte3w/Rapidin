import path from 'node:path';

const EXPENSE_LABELS = {
  gps: 'GPS',
  soat: 'SOAT',
  impuesto_vehicular: 'IMPUESTO_VEHICULAR',
  str_gps: 'STR_GPS',
  todo_riesgo_mas_gps_agrupado: 'STR_GPS',
  inicial_parcial: 'INICIAL_PARCIAL',
  src: 'SRC',
  generico: 'OTRO_GASTO',
};

function safeSegment(value, fallback) {
  const normalized = String(value || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || fallback;
}

function safeExtension(originalName, mimeType) {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  if (['.pdf', '.jpg', '.jpeg', '.png'].includes(extension)) return extension;
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  return '.jpg';
}

export function expenseDocumentLabel(type) {
  return EXPENSE_LABELS[String(type || '').toLowerCase()] || EXPENSE_LABELS.generico;
}

export function buildOtherExpenseDocumentName({
  driverName,
  dni,
  expenseType,
  installmentNumber,
  dueDate,
  originalName,
  mimeType,
  origin,
  uploadedAt = new Date(),
}) {
  const conductor = safeSegment(driverName || dni, 'CONDUCTOR');
  const concept = expenseDocumentLabel(expenseType);
  const installment = Math.max(1, Number(installmentNumber) || 1);
  const date = String(dueDate || uploadedAt.toISOString()).slice(0, 10);
  const uploadStamp = uploadedAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const extension = safeExtension(originalName, mimeType);
  const displayName = `${conductor}_${concept}_CUOTA_${installment}_${date}${extension}`;
  const objectName = [
    'comprobantes',
    safeSegment(origin, 'CONDUCTOR').toLowerCase(),
    concept.toLowerCase(),
    date.slice(0, 4),
    `${uploadStamp}_${displayName}`,
  ].join('/');

  return { displayName, objectName };
}
