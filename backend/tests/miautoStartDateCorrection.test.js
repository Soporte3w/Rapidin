import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  assertBootstrapWeeklyQuotaForStartDateCorrection,
  buildMiautoStartDateCorrection,
  normalizeMiautoStartDate,
} from '../yego_miauto/services/utils/miautoStartDateCorrection.js';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(here, '..');
const repositoryRoot = resolve(backendRoot, '..');
const readBackend = (relativePath) => readFileSync(resolve(backendRoot, relativePath), 'utf8');
const readRepository = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), 'utf8');

test('valida fechas reales y conserva el formato civil YYYY-MM-DD', () => {
  assert.equal(normalizeMiautoStartDate('2028-02-29'), '2028-02-29');
  assert.throws(() => normalizeMiautoStartDate('2027-02-29'), /no es una fecha válida/);
  assert.throws(() => normalizeMiautoStartDate('03/08/2026'), /formato YYYY-MM-DD/);
});

test('calcula la semana de depósito anterior y nueva al corregir la fecha', () => {
  assert.deepEqual(buildMiautoStartDateCorrection('2026-08-02', '2026-08-03'), {
    currentDate: '2026-08-02',
    nextDate: '2026-08-03',
    currentWeekStart: '2026-07-27',
    nextWeekStart: '2026-08-03',
    changed: true,
  });
});

test('solo acepta la cuota inicial cubierta y sin actividad financiera', () => {
  const bootstrap = {
    id: 'cuota-1',
    week_start_date: '2026-08-03',
    status: 'paid',
    amount_due: 100,
    paid_amount: 100,
    num_viajes: 0,
    partner_fees_raw: 0,
    partner_fees_83: 0,
    bono_auto: 0,
    cobro_saldo: 0,
    late_fee: 0,
    mora_extra: 0,
    pago_puntual: false,
  };
  assert.equal(
    assertBootstrapWeeklyQuotaForStartDateCorrection([bootstrap], '2026-08-03'),
    bootstrap,
  );
  assert.throws(
    () => assertBootstrapWeeklyQuotaForStartDateCorrection([bootstrap, { ...bootstrap, id: 'cuota-2' }], '2026-08-03'),
    /cuotas posteriores/,
  );
  assert.throws(
    () => assertBootstrapWeeklyQuotaForStartDateCorrection([{ ...bootstrap, num_viajes: 1 }], '2026-08-03'),
    /actividad financiera/,
  );
});

test('expone una ruta administrativa propia, transaccional y auditada', () => {
  const route = readBackend('yego_miauto/routes/miauto/solicitudes.js');
  const service = readBackend('yego_miauto/services/solicitud/miautoSolicitudService.js');
  const frontend = readRepository('frontend/src/pages/yegoMiAuto/YegoMiAutoRentSaleDetail.tsx');

  assert.match(route, /patch\('\/solicitudes\/:id\/fecha-inicio-cobro'/);
  assert.match(route, /Sin permisos para modificar el inicio de cobro/);
  assert.match(service, /corregirFechaInicioCobro[\s\S]*withTransaction/);
  assert.match(service, /FOR UPDATE/);
  assert.match(service, /start_date_corrected/);
  assert.match(frontend, /Modificar inicio de cobro/);
  assert.match(frontend, /\/fecha-inicio-cobro/);
});
