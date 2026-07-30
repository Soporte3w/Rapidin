function documentDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Selecciona únicamente una coincidencia exacta por documento. */
export function selectFacturadorCustomerByDocument(customers, documentNumber) {
  const document = documentDigits(documentNumber);
  if (!/^\d{8}$/.test(document) || !Array.isArray(customers)) return null;

  const matches = customers.filter((customer) => documentDigits(customer?.number) === document);
  if (matches.length > 1) {
    throw new Error(`El facturador devolvió más de un cliente para el DNI ${document}`);
  }
  if (matches.length === 0) return null;

  const id = Number(matches[0]?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`El cliente del DNI ${document} no tiene un ID válido en el facturador`);
  }
  return { ...matches[0], id, number: document };
}
