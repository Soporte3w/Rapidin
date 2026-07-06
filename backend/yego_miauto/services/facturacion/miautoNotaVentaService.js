import http from 'node:http';
import https from 'node:https';
import { getClient, query } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';
import { getCuotasSemanalesConRacha } from '../cuotas/miautoCuotaSemanalService.js';

const FACTURADOR_BASE_URL = (process.env.FACTURADOR_BASE_URL || 'https://ajhla.facturador.3w.pe').replace(/\/+$/, '');
const FACTURADOR_SERIES_ID = Number(process.env.FACTURADOR_SERIES_ID || 10);
const FACTURADOR_PREFIX = process.env.FACTURADOR_PREFIX || 'NV';
const FACTURADOR_ESTABLISHMENT_ID = Number(process.env.FACTURADOR_ESTABLISHMENT_ID || 1);
const FACTURADOR_SELLER_ID = Number(process.env.FACTURADOR_SELLER_ID || 2);
const FACTURADOR_ITEM_ID = Number(process.env.FACTURADOR_ITEM_ID || 1);
const FACTURADOR_PAYMENT_METHOD_TYPE_ID = process.env.FACTURADOR_PAYMENT_METHOD_TYPE_ID || '01';
const IGV_RATE = Number(process.env.FACTURADOR_IGV_RATE || 0.18);
const FACTURADOR_TLS_REJECT_UNAUTHORIZED = process.env.FACTURADOR_TLS_REJECT_UNAUTHORIZED === '1';

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
    error.data = data;
    throw error;
  }
  return data;
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

function buildItemLine(baseItem, cuota, index, currencyTypeId) {
  const total = round2(cuota.amount);
  const totalValue = round2(total / (1 + IGV_RATE));
  const totalIgv = round2(total - totalValue);
  const item = {
    ...baseItem,
    description: `Cuota semanal ${cuota.semana || index + 1} - Yego Mi Auto`,
    name_product_pdf: `<p>Cuota semanal ${cuota.semana || index + 1} - Yego Mi Auto</p>`,
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

function buildSaleNotePayload({ customerId, currencyTypeId, exchangeRateSale, item, cuotas, observation }) {
  const now = new Date();
  const dateOfIssue = limaYmd(now);
  const items = cuotas.map((cuota, index) => buildItemLine(item, cuota, index, currencyTypeId));
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
     FROM module_miauto_solicitud s
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

export async function listNotasVentaBySolicitud(solicitudId) {
  await ensureNotaVentaTables({ query });
  const res = await query(
    `SELECT nv.id, nv.facturador_sale_note_id, nv.number_full, nv.external_id, nv.print_a4,
            nv.customer_id, nv.currency_type_id, nv.exchange_rate_sale, nv.total, nv.created_at,
            COALESCE(json_agg(json_build_object('cuota_semanal_id', nc.cuota_semanal_id, 'amount', nc.amount) ORDER BY nc.created_at)
              FILTER (WHERE nc.id IS NOT NULL), '[]'::json) AS cuotas
     FROM module_miauto_nota_venta nv
     LEFT JOIN module_miauto_nota_venta_cuota nc ON nc.nota_venta_id = nv.id
     WHERE nv.solicitud_id = $1::uuid AND nv.deleted_at IS NULL
     GROUP BY nv.id
     ORDER BY nv.created_at DESC`,
    [solicitudId]
  );
  return res.rows || [];
}

export async function generarNotaVentaCuotasPagadas(solicitudId, cuotaIds, opts = {}) {
  if (!Array.isArray(cuotaIds) || cuotaIds.length === 0) {
    throw new Error('Selecciona al menos una cuota pagada');
  }
  const uniqueCuotaIds = [...new Set(cuotaIds.map((x) => String(x).trim()).filter(Boolean))];

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureNotaVentaTables(client);
    const { solicitud, cuotas } = await loadSolicitudAndCuotas(client, solicitudId, uniqueCuotaIds);
    const customerId = Number(opts.customer_id || solicitud.facturador_customer_id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      throw new Error('Indica el customer_id del facturador');
    }
    const { data: cuotasApi } = await getCuotasSemanalesConRacha(solicitudId, { incluirAbonoComprobantePendiente: false });
    const apiById = new Map((cuotasApi || []).map((c) => [String(c.id), c]));
    const allCuotasOrdenadas = (cuotasApi || []).length > 0 ? cuotasApi : cuotas;

    const seleccionadas = cuotas.map((cuota) => {
      const apiRow = apiById.get(String(cuota.id)) || cuota;
      const status = String(apiRow.status || cuota.status || '').toLowerCase();
      const paidAmount = round2(apiRow.paid_amount ?? cuota.paid_amount ?? 0);
      if (status !== 'paid') {
        throw new Error('Solo puedes generar nota de venta para cuotas con estado pagado');
      }
      if (paidAmount <= 0.005) {
        throw new Error('Una cuota pagada no tiene monto pagado válido');
      }
      const moneda = normalizeSaleCurrency(apiRow.moneda || cuota.moneda);
      return {
        id: String(cuota.id),
        amount: paidAmount,
        semana: semanaOrdinal(allCuotasOrdenadas, cuota),
        moneda,
      };
    });
    const monedasSeleccionadas = [...new Set(seleccionadas.map((c) => c.moneda))];
    if (monedasSeleccionadas.length !== 1) {
      throw new Error('No puedes mezclar cuotas en soles y dólares en una misma nota de venta');
    }
    const currencyTypeId = monedasSeleccionadas[0] || 'PEN';

    const issueDate = limaYmd();
    const [exchangeRateSale, item] = await Promise.all([
      getExchangeRate(issueDate),
      getFacturadorItem(),
    ]);
    const observation = opts.observation || `Yego Mi Auto${solicitud.dni ? ` - DNI ${solicitud.dni}` : ''}`;
    const payload = buildSaleNotePayload({
      customerId,
      currencyTypeId,
      exchangeRateSale,
      item,
      cuotas: seleccionadas,
      observation,
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

    let record = null;
    try {
      record = await facturadorRequest(`/sale-notes/record/${saleNoteId}`, { method: 'GET' });
    } catch (error) {
      logger.warn('No se pudo consultar record de nota de venta', { saleNoteId, error: error.message });
    }

    let cashResponse = null;
    try {
      cashResponse = await facturadorRequest('/cash/cash_document', {
        method: 'POST',
        body: JSON.stringify({ document_id: null, sale_note_id: saleNoteId }),
      });
    } catch (error) {
      logger.warn('No se pudo registrar nota de venta en caja', { saleNoteId, error: error.message });
      cashResponse = { success: false, message: error.message, data: error.data || null };
    }

    const factData = record?.data || saleNoteResponse?.data || {};
    const insertRes = await client.query(
      `INSERT INTO module_miauto_nota_venta
       (solicitud_id, facturador_sale_note_id, number_full, external_id, print_a4, customer_id,
        currency_type_id, exchange_rate_sale, total, payload, response, cash_response, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)
       RETURNING *`,
      [
        solicitudId,
        Number(saleNoteId),
        factData.number_full || factData.full_number || saleNoteResponse?.data?.number_full || null,
        factData.external_id || null,
        factData.print_a4 || null,
        customerId,
        currencyTypeId,
        exchangeRateSale,
        payload.total,
        JSON.stringify(payload),
        JSON.stringify({ saleNoteResponse, record }),
        JSON.stringify(cashResponse),
        opts.created_by || null,
      ]
    );
    const nota = insertRes.rows[0];
    for (const cuota of seleccionadas) {
      await client.query(
        `INSERT INTO module_miauto_nota_venta_cuota (nota_venta_id, cuota_semanal_id, amount)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [nota.id, cuota.id, cuota.amount]
      );
    }
    await client.query('COMMIT');

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
      cash_response: cashResponse,
    };
  } catch (error) {
    await client.query('ROLLBACK');
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
