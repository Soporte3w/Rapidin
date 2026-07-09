import http from 'node:http';
import https from 'node:https';
import { getClient, query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import { getCuotasSemanalesConRacha } from '../cuotas/miautoCuotaSemanalService.js';
import { uploadFileToMedia } from '../../../services/voucherService.js';

const FACTURADOR_BASE_URL = (process.env.FACTURADOR_BASE_URL || 'https://ajhla.facturador.3w.pe').replace(/\/+$/, '');
const FACTURADOR_SERIES_ID = Number(process.env.FACTURADOR_SERIES_ID || 10);
const FACTURADOR_PREFIX = process.env.FACTURADOR_PREFIX || 'NV';
const FACTURADOR_ESTABLISHMENT_ID = Number(process.env.FACTURADOR_ESTABLISHMENT_ID || 1);
const FACTURADOR_SELLER_ID = Number(process.env.FACTURADOR_SELLER_ID || 2);
const FACTURADOR_ITEM_ID = Number(process.env.FACTURADOR_ITEM_ID || 1);
const FACTURADOR_PAYMENT_METHOD_TYPE_ID = process.env.FACTURADOR_PAYMENT_METHOD_TYPE_ID || '01';
const MIAUTO_NOTAS_VENTA_BUCKET = process.env.MIAUTO_NOTAS_VENTA_BUCKET || 'miauto-notas-venta';
const IGV_RATE = Number(process.env.FACTURADOR_IGV_RATE || 0.18);
const FACTURADOR_TLS_REJECT_UNAUTHORIZED = process.env.FACTURADOR_TLS_REJECT_UNAUTHORIZED === '1';
const DRIVER_NAME_SELECT_SQL = `
  NULLIF(TRIM(CONCAT_WS(' ', rd.first_name, rd.last_name)), '') AS rapidin_driver_name,
  NULLIF(TRIM(CONCAT_WS(' ', fl.first_name, fl.last_name)), '') AS fleet_driver_name
`;
const DRIVER_NAME_JOIN_SQL = `
  LEFT JOIN module_rapidin_drivers rd ON rd.id::text = s.driver_id_fleet
  LEFT JOIN LATERAL (
    SELECT d.first_name, d.last_name
    FROM drivers d
    WHERE (
        d.driver_id = s.driver_id_fleet
        OR REGEXP_REPLACE(COALESCE(TRIM(d.license_number), ''), '[^0-9]', '', 'g') =
           REGEXP_REPLACE(COALESCE(TRIM(s.dni), ''), '[^0-9]', '', 'g')
      )
    ORDER BY CASE WHEN d.driver_id = s.driver_id_fleet THEN 0 ELSE 1 END, d.driver_id::text
    LIMIT 1
  ) fl ON true
`;
const CUOTA_SEMANA_JOIN_SQL = `
  LEFT JOIN (
    SELECT c.id,
           DENSE_RANK() OVER (
             PARTITION BY c.solicitud_id
             ORDER BY COALESCE(c.week_start_date, c.due_date) ASC NULLS LAST
           ) AS semana
    FROM module_miauto_cuota_semanal c
    WHERE c.solicitud_id = $1::uuid AND c.deleted_at IS NULL
  ) cw ON cw.id = nc.cuota_semanal_id
`;

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeSaleCurrency(moneda) {
  return String(moneda || '').trim().toUpperCase() === 'USD' ? 'USD' : 'PEN';
}

function limaYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function limaTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Lima',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function ymdFromDbDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePersonName(...parts) {
  return cleanText(parts.filter(Boolean).join(' ')).toUpperCase();
}

function sanitizeFileName(value) {
  return cleanText(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+-\s+/g, ' - ')
    .slice(0, 180);
}

function cuotaLabelFromCuotas(cuotas = []) {
  const semanas = [...new Set(cuotas.map((c) => Number(c.semana)).filter((n) => Number.isFinite(n) && n > 0))]
    .sort((a, b) => a - b);
  if (semanas.length === 0) return cuotas.length > 1 ? 'CUOTAS' : 'CUOTA';
  if (semanas.length === 1) return `CUOTA #${semanas[0]}`;
  return `CUOTAS #${semanas.join(', #')}`;
}

function notaVentaBaseName({ numberFull, dateYmd, cuotas, driverName }) {
  const number = cleanText(numberFull);
  const date = cleanText(dateYmd).replace(/\D/g, '') || limaYmd().replace(/\D/g, '');
  const conductor = normalizePersonName(driverName) || 'CONDUCTOR';
  return sanitizeFileName([number, date, cuotaLabelFromCuotas(cuotas), conductor, 'YEGO MI AUTO'].filter(Boolean).join(' - '));
}

function driverNameFromRow(row = {}) {
  return row.rapidin_driver_name || row.fleet_driver_name || null;
}

function notaVentaDownloadName(nota, driverName, dateYmd = ymdFromDbDate(nota?.created_at)) {
  return `${notaVentaBaseName({
    numberFull: nota?.number_full || `NV-${nota?.facturador_sale_note_id || ''}`,
    dateYmd,
    cuotas: nota?.cuotas || [],
    driverName,
  })}.pdf`;
}

function facturadorErrorPayload(error) {
  return {
    success: false,
    message: error?.message || 'Error consultando facturador',
    status: error?.status || null,
    data: error?.data || null,
    at: new Date().toISOString(),
  };
}

function pickResponsePdfUrl(response) {
  if (!response || typeof response !== 'object') return null;
  return response.minio_pdf_url
    || response.facturador_print_a4
    || response.record?.data?.print_a4
    || response.record?.print_a4
    || null;
}

async function uploadNotaVentaPdfToMinio({ solicitudId, nota, cuotas, driverName, sourceUrl, dateYmd }) {
  if (!sourceUrl) return null;
  const pdf = await facturadorBinaryRequest(sourceUrl);
  const fileName = notaVentaDownloadName({ ...nota, cuotas }, driverName, dateYmd);
  const objectName = `${solicitudId}/${Date.now()}-${fileName}`;
  return await uploadFileToMedia(
    {
      buffer: pdf.buffer,
      mimetype: pdf.contentType || 'application/pdf',
      originalname: objectName,
      size: pdf.buffer.length,
    },
    { bucket: MIAUTO_NOTAS_VENTA_BUCKET }
  );
}

function facturadorHeaders() {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (process.env.FACTURADOR_AUTHORIZATION) {
    headers.Authorization = process.env.FACTURADOR_AUTHORIZATION;
  }
  if (process.env.FACTURADOR_COOKIE) {
    headers.Cookie = process.env.FACTURADOR_COOKIE;
    const xsrfMatch = process.env.FACTURADOR_COOKIE.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
    if (xsrfMatch?.[1]) {
      headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrfMatch[1]);
    }
  }
  if (process.env.FACTURADOR_X_CSRF_TOKEN) {
    headers['X-CSRF-TOKEN'] = process.env.FACTURADOR_X_CSRF_TOKEN;
  }
  if (process.env.FACTURADOR_EXTRA_HEADERS) {
    try {
      Object.assign(headers, JSON.parse(process.env.FACTURADOR_EXTRA_HEADERS));
    } catch (error) {
      logger.warn('FACTURADOR_EXTRA_HEADERS no es JSON válido', { error: error.message });
    }
  }
  return headers;
}

async function facturadorRequest(path, options = {}) {
  const url = new URL(`${FACTURADOR_BASE_URL}${path}`);
  const method = options.method || 'GET';
  const body = options.body || null;
  const headers = { ...facturadorHeaders(), ...(options.headers || {}) };
  if (body && !headers['Content-Length']) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = Number(process.env.FACTURADOR_TIMEOUT_MS || 25000);

  const text = await new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: FACTURADOR_TLS_REJECT_UNAUTHORIZED,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode || 0, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout consultando facturador (${timeoutMs}ms)`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  let data = null;
  if (text.raw) {
    try {
      data = JSON.parse(text.raw);
    } catch {
      data = { raw: text.raw };
    }
  }
  if (text.statusCode < 200 || text.statusCode >= 300) {
    const msg = data?.message || data?.error || `Facturador respondió HTTP ${text.statusCode}`;
    const error = new Error(msg);
    error.status = text.statusCode;
    error.source = 'facturador';
    error.data = data;
    throw error;
  }
  return data;
}

async function facturadorBinaryRequest(urlOrPath) {
  const url = /^https?:\/\//i.test(String(urlOrPath || ''))
    ? new URL(urlOrPath)
    : new URL(`${FACTURADOR_BASE_URL}${urlOrPath}`);
  const headers = facturadorHeaders();
  delete headers['Content-Type'];
  const transport = url.protocol === 'https:' ? https : http;
  const timeoutMs = Number(process.env.FACTURADOR_TIMEOUT_MS || 25000);

  return await new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: FACTURADOR_TLS_REJECT_UNAUTHORIZED,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          const error = new Error(`Facturador respondió HTTP ${res.statusCode || 0}`);
          error.status = res.statusCode || 502;
          error.source = 'facturador';
          error.data = buffer.toString('utf8');
          reject(error);
          return;
        }
        resolve({
          buffer,
          contentType: res.headers['content-type'] || 'application/pdf',
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout descargando nota de venta (${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });
}

async function getExchangeRate(dateYmd) {
  const data = await facturadorRequest(`/services/exchange/${dateYmd}`, { method: 'GET' });
  return Number(data?.sale || data?.data?.sale || process.env.FACTURADOR_EXCHANGE_RATE_SALE || 1);
}

async function getFacturadorItem() {
  const data = await facturadorRequest('/sale-notes/table/items', { method: 'GET' });
  const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const item = items.find((x) => Number(x.id) === FACTURADOR_ITEM_ID) || items[0];
  if (!item) throw new Error('El facturador no devolvió items para la nota de venta');
  return item;
}

function buildItemLine(baseItem, cuota, index, currencyTypeId, driverName) {
  const total = round2(cuota.amount);
  const totalValue = round2(total / (1 + IGV_RATE));
  const totalIgv = round2(total - totalValue);
  const cuotaLabel = `CUOTA #${cuota.semana || index + 1}`;
  const description = `${cuotaLabel} - ${normalizePersonName(driverName) || 'CONDUCTOR'} - YEGO MI AUTO`;
  const item = {
    ...baseItem,
    description,
    name_product_pdf: `<p>${description}</p>`,
    sale_unit_price: total,
  };
  return {
    item_id: Number(baseItem.id || FACTURADOR_ITEM_ID),
    item,
    quantity: 1,
    unit_type_id: baseItem.unit_type_id || 'NIU',
    currency_type_id: currencyTypeId,
    unit_value: totalValue,
    unit_price: total,
    input_unit_price_value: total,
    affectation_igv_type_id: baseItem.sale_affectation_igv_type_id || '10',
    price_type_id: '01',
    price_type: {
      id: '01',
      active: 1,
      description: 'Precio unitario (incluye el IGV)',
    },
    total_base_igv: totalValue,
    percentage_igv: IGV_RATE * 100,
    total_igv: totalIgv,
    total_taxes: totalIgv,
    total_value: totalValue,
    total_charge: 0,
    total_discount: 0,
    total: total,
    charges: [],
    discounts: [],
    attributes: [],
  };
}

function buildSaleNotePayload({ customerId, currencyTypeId, exchangeRateSale, item, cuotas, observation, driverName }) {
  const now = new Date();
  const dateOfIssue = limaYmd(now);
  const items = cuotas.map((cuota, index) => buildItemLine(item, cuota, index, currencyTypeId, driverName));
  const total = round2(items.reduce((sum, x) => sum + Number(x.total || 0), 0));
  const totalValue = round2(items.reduce((sum, x) => sum + Number(x.total_value || 0), 0));
  const totalIgv = round2(items.reduce((sum, x) => sum + Number(x.total_igv || 0), 0));

  return {
    id: null,
    series_id: FACTURADOR_SERIES_ID,
    prefix: FACTURADOR_PREFIX,
    establishment_id: FACTURADOR_ESTABLISHMENT_ID,
    due_date: null,
    date_of_issue: dateOfIssue,
    time_of_issue: limaTime(now),
    customer_id: Number(customerId),
    currency_type_id: currencyTypeId,
    exchange_rate_sale: exchangeRateSale,
    seller_id: FACTURADOR_SELLER_ID,
    paid: true,
    payment_method_type_id: null,
    payments: [{
      id: null,
      document_id: null,
      date_of_payment: dateOfIssue,
      payment_method_type_id: FACTURADOR_PAYMENT_METHOD_TYPE_ID,
      payment: total,
      reference: null,
    }],
    items,
    subtotal: total,
    total,
    total_value: totalValue,
    total_taxed: totalValue,
    total_igv: totalIgv,
    total_taxes: totalIgv,
    total_base_isc: 0,
    total_base_other_taxes: 0,
    total_charge: 0,
    total_discount: 0,
    total_exonerated: 0,
    total_exportation: 0,
    total_free: 0,
    total_igv_free: 0,
    total_isc: 0,
    total_other_taxes: 0,
    total_prepayment: 0,
    total_unaffected: 0,
    operation_type_id: null,
    license_plate: null,
    observation: observation || null,
    additional_information: null,
    terms_condition: null,
    purchase_order: null,
    guides: [],
    charges: [],
    discounts: [],
    attributes: [],
    actions: { format_pdf: 'a4' },
    apply_concurrency: false,
    enabled_concurrency: false,
    automatic_date_of_issue: null,
    quantity_period: 0,
    type_period: null,
  };
}

async function ensureNotaVentaTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS module_miauto_nota_venta (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id UUID NOT NULL REFERENCES module_miauto_solicitud(id) ON DELETE CASCADE,
      facturador_sale_note_id INTEGER NOT NULL,
      number_full VARCHAR(50),
      external_id VARCHAR(120),
      print_a4 TEXT,
      customer_id INTEGER NOT NULL,
      currency_type_id VARCHAR(10) NOT NULL DEFAULT 'PEN',
      exchange_rate_sale NUMERIC(12,4),
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payload JSONB,
      response JSONB,
      cash_response JSONB,
      created_by UUID REFERENCES module_rapidin_users(id),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS module_miauto_nota_venta_cuota (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      nota_venta_id UUID NOT NULL REFERENCES module_miauto_nota_venta(id) ON DELETE CASCADE,
      cuota_semanal_id UUID NOT NULL REFERENCES module_miauto_cuota_semanal(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cuota_semanal_id)
    )
  `);
}

async function loadSolicitudAndCuotas(client, solicitudId, cuotaIds) {
  const solRes = await client.query(
    `SELECT s.id, s.dni, s.country, s.placa_asignada, s.facturador_customer_id,
            ${DRIVER_NAME_SELECT_SQL}
     FROM module_miauto_solicitud s
     ${DRIVER_NAME_JOIN_SQL}
     WHERE s.id = $1::uuid
     LIMIT 1`,
    [solicitudId]
  );
  const solicitud = solRes.rows[0];
  if (!solicitud) throw new Error('Solicitud no encontrada');

  const cuotasRes = await client.query(
    `SELECT id, solicitud_id, week_start_date, due_date, paid_amount, status, moneda
     FROM module_miauto_cuota_semanal
     WHERE solicitud_id = $1::uuid
       AND id = ANY($2::uuid[])
       AND deleted_at IS NULL
     ORDER BY week_start_date ASC NULLS LAST, due_date ASC NULLS LAST, id ASC
     FOR UPDATE`,
    [solicitudId, cuotaIds]
  );
  if (cuotasRes.rows.length !== cuotaIds.length) {
    throw new Error('Una o más cuotas no pertenecen a este contrato');
  }

  const dupRes = await client.query(
    `SELECT nc.cuota_semanal_id, nv.number_full
     FROM module_miauto_nota_venta_cuota nc
     INNER JOIN module_miauto_nota_venta nv ON nv.id = nc.nota_venta_id
     WHERE nc.cuota_semanal_id = ANY($1::uuid[])
       AND nv.deleted_at IS NULL`,
    [cuotaIds]
  );
  if (dupRes.rows.length > 0) {
    throw new Error(`Hay cuota(s) que ya tienen nota de venta: ${dupRes.rows.map((x) => x.number_full || x.cuota_semanal_id).join(', ')}`);
  }

  return { solicitud, cuotas: cuotasRes.rows };
}

function semanaOrdinal(cuotasOrdenadas, cuota) {
  const target = ymdFromDbDate(cuota.week_start_date) || ymdFromDbDate(cuota.due_date);
  if (!target) return null;
  const unique = [...new Set(cuotasOrdenadas.map((c) => ymdFromDbDate(c.week_start_date) || ymdFromDbDate(c.due_date)).filter(Boolean))];
  const idx = unique.indexOf(target);
  return idx >= 0 ? idx + 1 : null;
}

async function buildCuotasSeleccionadas(solicitudId, cuotas, { requirePaid = true } = {}) {
  const { data: cuotasApi } = await getCuotasSemanalesConRacha(solicitudId, { incluirAbonoComprobantePendiente: false });
  const apiById = new Map((cuotasApi || []).map((c) => [String(c.id), c]));
  const allCuotasOrdenadas = (cuotasApi || []).length > 0 ? cuotasApi : cuotas;

  const seleccionadas = cuotas.map((cuota) => {
    const apiRow = apiById.get(String(cuota.id)) || cuota;
    const status = String(apiRow.status || cuota.status || '').toLowerCase();
    const paidAmount = round2(apiRow.paid_amount ?? cuota.paid_amount ?? 0);
    if (requirePaid && status !== 'paid') {
      throw new Error('Solo puedes generar nota de venta para cuotas con estado pagado');
    }
    if (paidAmount <= 0.005) {
      throw new Error('Una cuota pagada no tiene monto pagado válido');
    }
    return {
      id: String(cuota.id),
      amount: paidAmount,
      semana: semanaOrdinal(allCuotasOrdenadas, cuota),
      moneda: normalizeSaleCurrency(apiRow.moneda || cuota.moneda),
    };
  });
  const monedas = [...new Set(seleccionadas.map((c) => c.moneda))];
  if (monedas.length !== 1) {
    throw new Error('No puedes mezclar cuotas en soles y dólares en una misma nota de venta');
  }
  return { seleccionadas, currencyTypeId: monedas[0] || 'PEN' };
}

async function ensureFacturadorSaleNoteDisponible(client, saleNoteId) {
  const res = await client.query(
    `SELECT id, number_full
     FROM module_miauto_nota_venta
     WHERE facturador_sale_note_id = $1
       AND deleted_at IS NULL
     LIMIT 1`,
    [Number(saleNoteId)]
  );
  if (res.rows.length > 0) {
    throw new Error(`La nota de venta del facturador ya existe en Yego Mi Auto: ${res.rows[0].number_full || saleNoteId}`);
  }
}

async function insertNotaVentaLocal(client, {
  solicitudId,
  saleNoteId,
  factData = {},
  customerId,
  currencyTypeId,
  exchangeRateSale,
  total,
  payload,
  response,
  createdBy,
  cuotas,
}) {
  const insertRes = await client.query(
    `INSERT INTO module_miauto_nota_venta
     (solicitud_id, facturador_sale_note_id, number_full, external_id, print_a4, customer_id,
      currency_type_id, exchange_rate_sale, total, payload, response, cash_response, created_by)
     VALUES ($1::uuid, $2, $3, $4, NULL, $5, $6, $7, $8, $9::jsonb, $10::jsonb, NULL, $11)
     RETURNING *`,
    [
      solicitudId,
      Number(saleNoteId),
      factData.number_full || factData.full_number || null,
      factData.external_id || null,
      customerId,
      currencyTypeId,
      exchangeRateSale,
      total,
      JSON.stringify(payload),
      JSON.stringify(response),
      createdBy || null,
    ]
  );
  const nota = insertRes.rows[0];
  for (const cuota of cuotas) {
    await client.query(
      `INSERT INTO module_miauto_nota_venta_cuota (nota_venta_id, cuota_semanal_id, amount)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [nota.id, cuota.id, cuota.amount]
    );
  }
  return nota;
}

async function appendNotaVentaResponse(notaId, patch) {
  const res = await query(
    `UPDATE module_miauto_nota_venta
     SET response = COALESCE(response, '{}'::jsonb) || $1::jsonb
     WHERE id = $2::uuid
     RETURNING *`,
    [JSON.stringify(patch), notaId]
  );
  return res.rows[0] || null;
}

async function enrichNotaVentaPostCommit({ nota, saleNoteId, solicitudId, cuotas, driverName, dateYmd, sourcePrintA4 = null }) {
  const warnings = [];
  let updatedNota = nota;
  let facturadorPrintA4 = sourcePrintA4;

  try {
    const record = await facturadorRequest(`/sale-notes/record/${saleNoteId}`, { method: 'GET' });
    const recordData = record?.data || {};
    facturadorPrintA4 = recordData.print_a4 || facturadorPrintA4;
    const res = await query(
      `UPDATE module_miauto_nota_venta
       SET number_full = COALESCE($1, number_full),
           external_id = COALESCE($2, external_id),
           response = COALESCE(response, '{}'::jsonb) || $3::jsonb
       WHERE id = $4::uuid
       RETURNING *`,
      [
        recordData.number_full || recordData.full_number || null,
        recordData.external_id || null,
        JSON.stringify({ record, facturador_print_a4: facturadorPrintA4 }),
        updatedNota.id,
      ]
    );
    updatedNota = res.rows[0] || updatedNota;
  } catch (error) {
    const warning = { step: 'record', ...facturadorErrorPayload(error) };
    warnings.push(warning);
    logger.warn('No se pudo consultar record de nota de venta; nota local conservada', { saleNoteId, error: error.message });
    try {
      await appendNotaVentaResponse(updatedNota.id, { record_error: warning });
    } catch (updateError) {
      logger.warn('No se pudo guardar advertencia de record en nota local', { saleNoteId, notaVentaId: updatedNota.id, error: updateError.message });
    }
  }

  if (facturadorPrintA4) {
    try {
      const minioPdfUrl = await uploadNotaVentaPdfToMinio({
        solicitudId,
        nota: { ...updatedNota, facturador_sale_note_id: saleNoteId },
        cuotas,
        driverName,
        sourceUrl: facturadorPrintA4,
        dateYmd,
      });
      const res = await query(
        `UPDATE module_miauto_nota_venta
         SET print_a4 = $1,
             response = COALESCE(response, '{}'::jsonb) || $2::jsonb
         WHERE id = $3::uuid
         RETURNING *`,
        [minioPdfUrl, JSON.stringify({ minio_pdf_url: minioPdfUrl, facturador_print_a4: facturadorPrintA4 }), updatedNota.id]
      );
      updatedNota = res.rows[0] || updatedNota;
    } catch (error) {
      const warning = { step: 'minio_pdf', ...facturadorErrorPayload(error) };
      warnings.push(warning);
      logger.warn('No se pudo subir PDF de nota de venta a MinIO; nota local conservada', { saleNoteId, notaVentaId: updatedNota.id, error: error.message });
      try {
        await appendNotaVentaResponse(updatedNota.id, { minio_pdf_error: warning, facturador_print_a4: facturadorPrintA4 });
      } catch (updateError) {
        logger.warn('No se pudo guardar advertencia de MinIO en nota local', { saleNoteId, notaVentaId: updatedNota.id, error: updateError.message });
      }
    }
  }

  return { nota: updatedNota, warnings };
}

async function persistCashResponse(notaId, saleNoteId) {
  let cashResponse = null;
  const warnings = [];
  try {
    cashResponse = await facturadorRequest('/cash/cash_document', {
      method: 'POST',
      body: JSON.stringify({ document_id: null, sale_note_id: saleNoteId }),
    });
  } catch (error) {
    cashResponse = facturadorErrorPayload(error);
    warnings.push({ step: 'cash', ...cashResponse });
    logger.warn('No se pudo registrar nota de venta en caja; nota local conservada', { saleNoteId, error: error.message });
  }

  try {
    const res = await query(
      `UPDATE module_miauto_nota_venta
       SET cash_response = $1::jsonb
       WHERE id = $2::uuid
       RETURNING *`,
      [JSON.stringify(cashResponse), notaId]
    );
    return { nota: res.rows[0] || null, cashResponse, warnings };
  } catch (error) {
    warnings.push({ step: 'cash_update', ...facturadorErrorPayload(error) });
    logger.warn('No se pudo guardar respuesta de caja en nota local', { saleNoteId, notaVentaId: notaId, error: error.message });
    return { nota: null, cashResponse, warnings };
  }
}

export async function listNotasVentaBySolicitud(solicitudId) {
  await ensureNotaVentaTables({ query });
  const res = await query(
    `SELECT nv.id, nv.facturador_sale_note_id, nv.number_full, nv.external_id, nv.print_a4,
            nv.customer_id, nv.currency_type_id, nv.exchange_rate_sale, nv.total, nv.created_at,
            COALESCE(json_agg(json_build_object('cuota_semanal_id', nc.cuota_semanal_id, 'amount', nc.amount, 'semana', cw.semana) ORDER BY nc.created_at)
              FILTER (WHERE nc.id IS NOT NULL), '[]'::json) AS cuotas
     FROM module_miauto_nota_venta nv
     LEFT JOIN module_miauto_nota_venta_cuota nc ON nc.nota_venta_id = nv.id
     ${CUOTA_SEMANA_JOIN_SQL}
     WHERE nv.solicitud_id = $1::uuid AND nv.deleted_at IS NULL
     GROUP BY nv.id
     ORDER BY nv.created_at DESC`,
    [solicitudId]
  );
  const solicitudRes = await query(
    `SELECT ${DRIVER_NAME_SELECT_SQL}
     FROM module_miauto_solicitud s
     ${DRIVER_NAME_JOIN_SQL}
     WHERE s.id = $1::uuid
     LIMIT 1`,
    [solicitudId]
  );
  const driverName = driverNameFromRow(solicitudRes.rows[0]);
  return (res.rows || []).map((nota) => ({
    ...nota,
    download_name: notaVentaDownloadName(nota, driverName),
  }));
}

export async function downloadNotaVentaPdfBySolicitud(solicitudId, notaVentaId) {
  await ensureNotaVentaTables({ query });
  const res = await query(
    `SELECT nv.id, nv.facturador_sale_note_id, nv.number_full, nv.print_a4, nv.response, nv.created_at,
            ${DRIVER_NAME_SELECT_SQL},
            COALESCE(json_agg(json_build_object('cuota_semanal_id', nc.cuota_semanal_id, 'amount', nc.amount, 'semana', cw.semana) ORDER BY nc.created_at)
              FILTER (WHERE nc.id IS NOT NULL), '[]'::json) AS cuotas
     FROM module_miauto_nota_venta nv
     INNER JOIN module_miauto_solicitud s ON s.id = nv.solicitud_id
     ${DRIVER_NAME_JOIN_SQL}
     LEFT JOIN module_miauto_nota_venta_cuota nc ON nc.nota_venta_id = nv.id
     ${CUOTA_SEMANA_JOIN_SQL}
     WHERE nv.id = $2::uuid
       AND nv.solicitud_id = $1::uuid
       AND nv.deleted_at IS NULL
     GROUP BY nv.id, rd.first_name, rd.last_name, fl.first_name, fl.last_name
     LIMIT 1`,
    [solicitudId, notaVentaId]
  );
  let nota = res.rows[0];
  if (!nota) throw new Error('Nota de venta no encontrada');
  const driverName = driverNameFromRow(nota);

  if (!nota.print_a4) {
    const responsePdfUrl = pickResponsePdfUrl(nota.response);
    if (responsePdfUrl) {
      const updateRes = await query(
        `UPDATE module_miauto_nota_venta
         SET print_a4 = $1,
             response = COALESCE(response, '{}'::jsonb) || $2::jsonb
         WHERE id = $3::uuid
         RETURNING *`,
        [responsePdfUrl, JSON.stringify({ recovered_print_a4: responsePdfUrl }), nota.id]
      );
      nota = { ...nota, ...(updateRes.rows[0] || {}), print_a4: responsePdfUrl };
    }
  }

  if (!nota.print_a4 && nota.facturador_sale_note_id) {
    const recovered = await enrichNotaVentaPostCommit({
      nota,
      saleNoteId: nota.facturador_sale_note_id,
      solicitudId,
      cuotas: nota.cuotas || [],
      driverName,
      dateYmd: ymdFromDbDate(nota.created_at),
      sourcePrintA4: pickResponsePdfUrl(nota.response),
    });
    nota = { ...nota, ...(recovered.nota || {}) };
  }

  if (!nota.print_a4) {
    throw new Error('No se pudo recuperar el PDF de la nota de venta. Verifica la cookie del facturador o vuelve a intentar en unos minutos.');
  }

  const pdf = await facturadorBinaryRequest(nota.print_a4);
  return {
    ...pdf,
    fileName: notaVentaDownloadName(nota, driverName),
  };
}

export async function anularNotaVentaBySolicitud(solicitudId, notaVentaId, userId = null) {
  await ensureNotaVentaTables({ query });
  const notaRes = await query(
    `SELECT id, solicitud_id, facturador_sale_note_id, number_full, response
     FROM module_miauto_nota_venta
     WHERE id = $1::uuid
       AND solicitud_id = $2::uuid
       AND deleted_at IS NULL
     LIMIT 1`,
    [notaVentaId, solicitudId]
  );
  const nota = notaRes.rows[0];
  if (!nota) throw new Error('Nota de venta no encontrada o ya anulada');
  if (!nota.facturador_sale_note_id) throw new Error('La nota no tiene ID del facturador');

  const anulacionResponse = await facturadorRequest(`/sale-notes/anulate/${nota.facturador_sale_note_id}`, {
    method: 'GET',
  });
  if (anulacionResponse?.success === false) {
    const error = new Error(anulacionResponse?.message || 'El facturador rechazó la anulación');
    error.status = 400;
    error.data = anulacionResponse;
    throw error;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT id
       FROM module_miauto_nota_venta
       WHERE id = $1::uuid
         AND solicitud_id = $2::uuid
         AND deleted_at IS NULL
       FOR UPDATE`,
      [notaVentaId, solicitudId]
    );
    if (locked.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Nota de venta no encontrada o ya anulada');
    }

    await client.query('DELETE FROM module_miauto_nota_venta_cuota WHERE nota_venta_id = $1::uuid', [notaVentaId]);
    const updateRes = await client.query(
      `UPDATE module_miauto_nota_venta
       SET deleted_at = CURRENT_TIMESTAMP,
           response = COALESCE(response, '{}'::jsonb) || $1::jsonb
       WHERE id = $2::uuid
       RETURNING *`,
      [
        JSON.stringify({
          anulacion: {
            response: anulacionResponse,
            by: userId || null,
            at: new Date().toISOString(),
          },
        }),
        notaVentaId,
      ]
    );
    await client.query('COMMIT');

    logger.info('Nota de venta Mi Auto anulada', {
      solicitudId,
      notaVentaId,
      facturadorSaleNoteId: nota.facturador_sale_note_id,
      numberFull: nota.number_full,
    });

    return {
      ...updateRes.rows[0],
      anulacion_response: anulacionResponse,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    logger.error('Error anulando nota de venta Mi Auto', {
      solicitudId,
      notaVentaId,
      facturadorSaleNoteId: nota.facturador_sale_note_id,
      error: error.message,
      status: error.status,
      data: error.data,
    });
    throw error;
  } finally {
    client.release();
  }
}

export async function generarNotaVentaCuotasPagadas(solicitudId, cuotaIds, opts = {}) {
  if (!Array.isArray(cuotaIds) || cuotaIds.length === 0) {
    throw new Error('Selecciona al menos una cuota pagada');
  }
  const uniqueCuotaIds = [...new Set(cuotaIds.map((x) => String(x).trim()).filter(Boolean))];

  const client = await getClient();
  let localCommitted = false;
  try {
    await client.query('BEGIN');
    await ensureNotaVentaTables(client);
    const { solicitud, cuotas } = await loadSolicitudAndCuotas(client, solicitudId, uniqueCuotaIds);
    const customerId = Number(opts.customer_id || solicitud.facturador_customer_id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw new Error('Este conductor no tiene customer ID del facturador vinculado');
    }
    const { seleccionadas, currencyTypeId } = await buildCuotasSeleccionadas(solicitudId, cuotas);

    const issueDate = limaYmd();
    const [exchangeRateSale, item] = await Promise.all([
      getExchangeRate(issueDate),
      getFacturadorItem(),
    ]);
    const observation = opts.observation || `Yego Mi Auto${solicitud.dni ? ` - DNI ${solicitud.dni}` : ''}`;
    const driverName = driverNameFromRow(solicitud);
    const payload = buildSaleNotePayload({
      customerId,
      currencyTypeId,
      exchangeRateSale,
      item,
      cuotas: seleccionadas,
      observation,
      driverName,
    });

    logger.info('Generando nota de venta Mi Auto', {
      solicitudId,
      cuotaIds: uniqueCuotaIds,
      customerId,
      currencyTypeId,
      total: payload.total,
    });

    const saleNoteResponse = await facturadorRequest('/sale-notes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (saleNoteResponse?.success === false) {
      const error = new Error(saleNoteResponse?.message || 'El facturador rechazó la nota de venta');
      error.status = 400;
      error.data = saleNoteResponse;
      throw error;
    }
    const saleNoteId =
      saleNoteResponse?.data?.id ||
      saleNoteResponse?.id ||
      saleNoteResponse?.data?.sale_note?.id ||
      saleNoteResponse?.sale_note?.id;
    if (!saleNoteId) {
      const error = new Error('El facturador no devolvió el ID de la nota de venta');
      error.status = 400;
      error.data = saleNoteResponse;
      throw error;
    }

    await ensureFacturadorSaleNoteDisponible(client, saleNoteId);

    const factData = saleNoteResponse?.data || {};
    let nota = await insertNotaVentaLocal(client, {
      solicitudId,
      saleNoteId,
      factData,
      customerId,
      currencyTypeId,
      exchangeRateSale,
      total: payload.total,
      payload,
      response: { saleNoteResponse, record: null, facturador_print_a4: factData.print_a4 || null },
      createdBy: opts.created_by || null,
      cuotas: seleccionadas,
    });
    await client.query('COMMIT');
    localCommitted = true;

    const post = await enrichNotaVentaPostCommit({
      nota,
      saleNoteId,
      solicitudId,
      cuotas: seleccionadas,
      driverName,
      dateYmd: issueDate,
      sourcePrintA4: factData.print_a4 || null,
    });
    nota = post.nota;
    const cash = await persistCashResponse(nota.id, saleNoteId);
    nota = cash.nota || nota;
    const warnings = [...post.warnings, ...cash.warnings];

    logger.info('Nota de venta Mi Auto generada', {
      solicitudId,
      notaVentaId: nota.id,
      numberFull: nota.number_full,
      facturadorSaleNoteId: saleNoteId,
      total: nota.total,
    });

    return {
      ...nota,
      cuotas: seleccionadas,
      download_name: notaVentaDownloadName({ ...nota, facturador_sale_note_id: saleNoteId, cuotas: seleccionadas }, driverName, issueDate),
      cash_response: cash.cashResponse,
      warnings,
    };
  } catch (error) {
    if (!localCommitted) {
      await client.query('ROLLBACK');
    }
    logger.error('Error generando nota de venta Mi Auto', {
      solicitudId,
      cuotaIds: uniqueCuotaIds,
      error: error.message,
      status: error.status,
      data: error.data,
    });
    throw error;
  } finally {
    client.release();
  }
}
