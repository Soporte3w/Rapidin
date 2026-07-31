import assert from 'node:assert/strict';
import test from 'node:test';
import { getLicenseInfo } from '../services/factilizaService.js';

test('consulta el endpoint de licencia y normaliza la respuesta de Factiliza', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FACTILIZA_API_TOKEN;
  let request;
  process.env.FACTILIZA_API_TOKEN = 'token-de-prueba';
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        data: {
          numero_documento: '10514343',
          nombre_completo: 'PERSONA DE PRUEBA',
          licencia: {
            numero: 'Q10514343',
            categoria: 'A IIa',
            fecha_expedicion: '',
            fecha_vencimiento: '31/12/2029',
            estado: 'VIGENTE',
            restricciones: 'CON LENTES',
          },
        },
      }),
    };
  };

  try {
    const result = await getLicenseInfo('10514343');
    assert.equal(request.url, 'https://api.factiliza.com/v1/licencia/info/10514343');
    assert.equal(request.options.headers.Authorization, 'Bearer token-de-prueba');
    assert.deepEqual(result, {
      documentNumber: '10514343',
      fullName: 'PERSONA DE PRUEBA',
      number: 'Q10514343',
      category: 'A IIa',
      issuedAt: null,
      expiresAt: '31/12/2029',
      status: 'VIGENTE',
      restrictions: 'CON LENTES',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FACTILIZA_API_TOKEN;
    else process.env.FACTILIZA_API_TOKEN = originalToken;
  }
});
