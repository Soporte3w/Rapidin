import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('las lecturas de notas y contratos no ejecutan DDL por solicitud', () => {
  const notas = read('yego_miauto/services/facturacion/miautoNotaVentaService.js');
  const contratos = read('yego_miauto/services/contratos/miautoContratoDocumentoService.js');

  assert.doesNotMatch(notas, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i);
  assert.doesNotMatch(contratos, /CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i);
});

test('el detalle administrativo usa una ruta consolidada sin retirar las rutas existentes', () => {
  const rootRouter = read('yego_miauto/routes/miauto.js');
  const dashboard = read('yego_miauto/routes/miauto/dashboard.js');

  assert.match(rootRouter, /router\.use\(dashboardRouter\)/);
  assert.match(dashboard, /router\.get\('\/solicitudes\/:id\/dashboard'/);
  assert.match(dashboard, /getSolicitudById/);
  assert.match(dashboard, /getCuotasSemanalesApiPayload/);
});

test('el listado de cronogramas no depende de caché en memoria', () => {
  const route = read('yego_miauto/routes/miauto/cronogramas.js');
  assert.doesNotMatch(route, /cronogramasListCache|CRONOGRAMAS_CACHE_TTL_MS/);
});
