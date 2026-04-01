/**
 * Yango/Fleet rechaza la recarga (add) cuando hay otra transacción en curso o entrante
 * para ese mismo perfil. Solo esos mensajes activan 409 + recarga manual en Rapidín
 * (no aplica a otros errores ni a otras solicitudes).
 */
export function isFleetPendingOrIncomingTransactionError(message) {
  const s = String(message || '').toLowerCase();
  if (!s) return false;
  if (/ongoing/.test(s) && /transaction/.test(s)) return true;
  if (/incoming/.test(s) && /transaction/.test(s)) return true;
  if (/transacci(o|ó)n(es)?\s+en\s+curso/.test(s)) return true;
  if (/has\s+transaction/.test(s) && /incoming/.test(s)) return true;
  return false;
}
