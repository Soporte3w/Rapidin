import assert from 'node:assert/strict';
import test from 'node:test';
import { getSoatInfo, normalizedPlate } from '../services/factilizaService.js';

test('normaliza la placa para consultar Factiliza', () => {
  assert.equal(normalizedPlate(' bea-458 '), 'BEA458');
  assert.throws(() => normalizedPlate('***'), /Placa inválida/);
});

test('consulta el endpoint SOAT y normaliza la respuesta de Factiliza', async () => {
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
        message: 'Exito',
        success: true,
        data: {
          placa: 'BEA458',
          nombre_compania: 'Mapfre Perú',
          fecha_inicio: '09/08/2025',
          fecha_fin: '09/08/2026',
          estado: 'VIGENTE',
          numero_poliza: '0000000000030225002760345',
          codigo_sbs_aseguradora: '',
          codigo_unico_poliza: '',
        },
      }),
    };
  };

  try {
    const result = await getSoatInfo('bea-458');
    assert.equal(request.url, 'https://api.factiliza.com/v1/placa/soat/BEA458');
    assert.equal(request.options.headers.Authorization, 'Bearer token-de-prueba');
    assert.deepEqual(result, {
      plate: 'BEA458',
      companyName: 'Mapfre Perú',
      startsAt: '09/08/2025',
      expiresAt: '09/08/2026',
      status: 'VIGENTE',
      policyNumber: '0000000000030225002760345',
      insurerSbsCode: null,
      uniquePolicyCode: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FACTILIZA_API_TOKEN;
    else process.env.FACTILIZA_API_TOKEN = originalToken;
  }
});
