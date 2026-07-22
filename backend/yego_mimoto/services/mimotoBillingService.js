export function getMimotoBillingStatus() {
  return {
    configured: false,
    provider: null,
    country: 'CO',
    supported_currencies: ['COP', 'USD'],
  };
}

export async function generateMimotoSaleNote() {
  const error = new Error('La facturación de Yego Mi Moto Colombia aún no tiene proveedor configurado');
  error.code = 'MIMOTO_BILLING_NOT_CONFIGURED';
  throw error;
}
