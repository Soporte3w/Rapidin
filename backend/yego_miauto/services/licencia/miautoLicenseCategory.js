/** Canonicaliza categorías como "A IIa" sin confundir A I con A II. */
export function normalizeMiautoLicenseCategory(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** A1, A 1 y A I representan la categoría básica y no califican. */
export function isMiautoLicenseCategoryValid(value) {
  const normalized = normalizeMiautoLicenseCategory(value);
  return normalized !== '' && normalized !== 'A1' && normalized !== 'AI';
}
