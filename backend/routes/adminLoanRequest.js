import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyToken, verifyRole } from '../middleware/auth.js';
import { validateDNI, getDriver, getDriverByPark, getDriverByPhoneAndPark, createDriverForPark, createOrUpdateDriver } from '../services/calculationsService.js';
import { createLoanRequest } from '../services/loanService.js';
import { uploadFileToMedia } from '../services/voucherService.js';
import { successResponse, errorResponse } from '../utils/responses.js';
import pool from '../database/connection.js';
import { query } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { simulateLoanOptions } from '../services/calculationsService.js';
import { getPartnerNameById } from '../services/partnersService.js';
import { getDniInfo } from '../services/factilizaService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadLoanDocFields = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|webp/;
    const ext = path.extname(file.originalname).toLowerCase();
    const mimetypeOk = allowedTypes.test(file.mimetype) || file.mimetype === 'image/webp';
    const extOk = ext ? allowedTypes.test(ext) : true;
    if (mimetypeOk && extOk) return cb(null, true);
    cb(new Error('Solo se permiten archivos JPEG, PNG, WebP o PDF'));
  }
}).fields([
  { name: 'id_document', maxCount: 1 },
  { name: 'contact_front_photo', maxCount: 1 },
  { name: 'contract_signature', maxCount: 1 }
]);

const router = express.Router();
router.use(verifyToken);
router.use(verifyRole('admin', 'approver', 'analyst'));

// Normalizar texto para búsqueda sin tildes/acentos (jesus -> Jesús, maria -> María)
function normalizeForSearch(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ñ/gi, 'n')
    .toLowerCase()
    .trim();
}

// Primera letra de cada palabra en mayúscula, resto en minúscula (MARIA LOPEZ -> Maria Lopez)
function toTitleCase(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** GET /api/admin/driver-search?q=Juan&country=PE - Buscar conductores por nombre solo en tabla drivers (work_status=working) */
router.get('/driver-search', async (req, res) => {
  try {
    const { q, country } = req.query;
    const term = (q && String(q).trim()) || '';
    if (term.length < 2) return successResponse(res, []);
    const normalizedTerm = normalizeForSearch(term);
    const searchPattern = '%' + normalizedTerm.replace(/\s+/g, '%') + '%';

    const norm = "translate(lower(coalesce(%s,'')), 'áéíóúüñ', 'aeiouun')";
    const normFirst = norm.replace(/%s/g, 'first_name');
    const normLast = norm.replace(/%s/g, 'last_name');
    const normFull = "translate(lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), 'áéíóúüñ', 'aeiouun')";
    const normFullReverse = "translate(lower(coalesce(last_name,'') || ' ' || coalesce(first_name,'')), 'áéíóúüñ', 'aeiouun')";
    const likeClause = `(${normFirst} LIKE $1 OR ${normLast} LIKE $1 OR ${normFull} LIKE $1 OR ${normFullReverse} LIKE $1)`;

    const licenseCountry = country === 'CO' ? 'col' : country === 'PE' ? 'per' : null;
    const driversFilter = licenseCountry ? 'AND license_country = $2' : '';
    const paramsDrivers = licenseCountry ? [searchPattern, licenseCountry] : [searchPattern];
    let rDrivers;
    try {
      rDrivers = await query(
        `SELECT id, driver_id, first_name, last_name, phone, document_number, document_type, license_country, park_id 
         FROM drivers 
         WHERE ${likeClause} AND work_status = 'working' ${driversFilter}
         ORDER BY last_name, first_name LIMIT 15`,
        paramsDrivers
      );
    } catch (errDrivers) {
      logger.warn('driver-search: tabla drivers no disponible', errDrivers.message);
      rDrivers = { rows: [] };
    }

    // Cada fila de drivers es una opción distinta (driver_id + park_id únicos). No agrupar por teléfono.
    const phoneNormForQuery = (phone, c) => {
      const digits = (phone || '').toString().replace(/\D/g, '');
      if (c === 'CO') return digits.length === 12 && digits.startsWith('57') ? `+${digits}` : `+57${digits}`;
      return digits.length === 11 && digits.startsWith('51') ? `+${digits}` : digits.length >= 9 ? `+51${digits.slice(-9)}` : `+${digits}`;
    };

    const results = [];
    for (const row of rDrivers.rows) {
      const countryMapped = (row.license_country || '').toLowerCase() === 'col' ? 'CO' : 'PE';
      const driverId = row.driver_id != null ? String(row.driver_id) : String(row.id);
      const parkId = row.park_id || null;
      const docTypeRaw = (row.document_type || '').toLowerCase();
      const docTypeLabel = docTypeRaw === 'cedula' ? 'Cédula' : docTypeRaw === 'dni' ? 'DNI' : (docTypeRaw || null);

      const flotaName = await getPartnerNameById(parkId) || parkId || 'Sin flota';
      let has_active_loan = false;
      // Documento y teléfono por opción: de esta fila de drivers; si existe en rapidin para este park_id, usar los de rapidin
      let item_phone = row.phone || '';
      let item_dni = (row.document_number || '').toString().trim();
      const phoneNorm = phoneNormForQuery(row.phone, countryMapped);
      const digitsOnly = (row.phone || '').toString().replace(/\D/g, '');

      const rapidinRow = await query(
        `SELECT id, phone, dni FROM module_rapidin_drivers 
         WHERE country = $1 AND COALESCE(park_id, '') = $2 
           AND (phone = $3 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
         LIMIT 1`,
        [countryMapped, (parkId || '').toString().trim(), phoneNorm, row.phone, digitsOnly]
      );
      if (rapidinRow.rows.length > 0) {
        const r = rapidinRow.rows[0];
        if (r.phone != null && String(r.phone).trim() !== '') item_phone = String(r.phone).trim();
        if (r.dni != null && String(r.dni).trim() !== '') item_dni = String(r.dni).trim();
        const loan = await query(
          'SELECT id FROM module_rapidin_loans WHERE driver_id = $1 AND status = $2 LIMIT 1',
          [r.id, 'active']
        );
        has_active_loan = loan.rows.length > 0;
      }

      results.push({
        id: 'driver-' + driverId + '-' + (parkId || 'sin-flota'),
        conductor_id: 'driver-' + driverId,
        source: 'driver',
        first_name: toTitleCase(row.first_name || ''),
        last_name: toTitleCase(row.last_name || ''),
        dni: item_dni,
        document_type: docTypeLabel,
        phone: item_phone,
        email: '',
        country: countryMapped,
        country_label: countryMapped === 'CO' ? 'CO (Colombiano)' : 'PE (Peruano)',
        flota: { park_id: parkId, flota_name: toTitleCase(flotaName), has_active_loan }
      });
    }

    return successResponse(res, results);
  } catch (e) {
    logger.error('Error admin driver-search:', e);
    return errorResponse(res, e.message || 'Error', 400);
  }
});

/** Normalizar teléfono para consultas (mismo criterio que en driver/routes). */
function normalizePhoneForQuery(phone, country) {
  const digits = (phone || '').toString().replace(/\D/g, '');
  if (country === 'CO') {
    return digits.length === 12 && digits.startsWith('57') ? `+${digits}` : `+57${digits}`;
  }
  return digits.length === 11 && digits.startsWith('51') ? `+${digits}` : digits.length >= 9 ? `+51${digits.slice(-9)}` : `+${digits}`;
}

/** GET /api/admin/driver-flotas?phone=xxx&country=PE - Flotas del conductor por teléfono (tabla drivers, work_status=working) */
router.get('/driver-flotas', async (req, res) => {
  try {
    const { phone, country } = req.query;
    const c = (country && String(country).trim().toUpperCase()) === 'CO' ? 'CO' : 'PE';
    const rawPhone = (phone != null && phone !== '') ? String(phone).trim() : '';
    if (!rawPhone) return errorResponse(res, 'Teléfono requerido', 400);

    const phoneNorm = normalizePhoneForQuery(rawPhone, c);
    const digitsOnly = (rawPhone || '').toString().replace(/\D/g, '');
    const licenseCountry = c === 'CO' ? 'col' : 'per';
    const flotasMap = new Map(); // park_id key -> { park_id, flota_name, has_active_loan, rapidin_driver_id }

    // Flotas desde drivers (Yego): por teléfono y work_status = 'working'
    const driversRows = await query(
      `SELECT id, driver_id, park_id FROM drivers 
       WHERE work_status = 'working' AND license_country = $1 
         AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
       ORDER BY COALESCE(park_id, '')`,
      [licenseCountry, phoneNorm, rawPhone, digitsOnly]
    );

    for (const row of driversRows.rows) {
      const parkId = row.park_id || null;
      const key = (parkId || '').toString().trim() || '__null__';
      const flotaName = await getPartnerNameById(parkId) || parkId || 'Sin flota';

      // ¿Tiene préstamo activo? Buscar en module_rapidin_drivers por phone+country+park_id y luego en loans
      let hasActiveLoan = false;
      let rapidinDriverId = null;
      const rapidinRow = await query(
        `SELECT id FROM module_rapidin_drivers 
         WHERE country = $1 AND COALESCE(park_id, '') = $2 
           AND (phone = $3 OR phone = $4 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $5)
         LIMIT 1`,
        [c, (parkId || '').toString().trim(), phoneNorm, rawPhone, digitsOnly]
      );
      if (rapidinRow.rows.length > 0) {
        rapidinDriverId = rapidinRow.rows[0].id;
        const loan = await query(
          'SELECT id FROM module_rapidin_loans WHERE driver_id = $1 AND status = $2 LIMIT 1',
          [rapidinDriverId, 'active']
        );
        hasActiveLoan = loan.rows.length > 0;
      }

      flotasMap.set(key, {
        park_id: parkId,
        flota_name: toTitleCase(flotaName),
        has_active_loan: hasActiveLoan,
        rapidin_driver_id: rapidinDriverId,
      });
    }

    const flotas = Array.from(flotasMap.values());
    return successResponse(res, flotas, 'Flotas del conductor');
  } catch (e) {
    logger.error('Error admin driver-flotas:', e);
    return errorResponse(res, e.message || 'Error', 400);
  }
});

/** GET /api/admin/dni-info?dni=12345678 - Obtener nombre por DNI desde API Factiliza (solo Perú, 8 dígitos) */
router.get('/dni-info', async (req, res) => {
  try {
    const { dni } = req.query;
    const trimmed = (dni && String(dni).trim().replace(/\D/g, '')) || '';
    if (trimmed.length !== 8) {
      return errorResponse(res, 'DNI debe tener 8 dígitos (Perú)', 400);
    }
    const info = await getDniInfo(trimmed);
    const fullName = (info.fullName || '').trim();
    if (!fullName) return successResponse(res, { fullName: '', first_name: '', last_name: '' });
    const parts = fullName.split(/\s+/).filter(Boolean);
    const first_name = parts[0] || '';
    const last_name = parts.slice(1).join(' ') || '';
    return successResponse(res, { fullName: toTitleCase(fullName), first_name: toTitleCase(first_name), last_name: toTitleCase(last_name) });
  } catch (e) {
    if (e.message && e.message.includes('FACTILIZA')) {
      return errorResponse(res, e.message, 400);
    }
    try {
      const driver = await getDriver(req.query.dni?.trim().replace(/\D/g, '') || '', 'PE');
      if (driver && (driver.first_name || driver.last_name)) {
        return successResponse(res, {
          fullName: toTitleCase([driver.first_name, driver.last_name].filter(Boolean).join(' ')),
          first_name: toTitleCase(driver.first_name || ''),
          last_name: toTitleCase(driver.last_name || '')
        });
      }
    } catch (_) {}
    return errorResponse(res, e.message || 'No se pudo obtener el nombre para este DNI', 400);
  }
});

/** GET /api/admin/driver-lookup?dni=xxx&country=PE o ?phone=xxx&country=PE - Buscar conductor para autocompletar nombre, apellido, email */
router.get('/driver-lookup', async (req, res) => {
  try {
    const { dni, phone, country } = req.query;
    if (!country) return errorResponse(res, 'País requerido', 400);
    let row = null;
    if (dni && String(dni).trim()) {
      const r = await query(
        'SELECT first_name, last_name, email, phone, dni FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1',
        [String(dni).trim(), country]
      );
      row = r.rows[0] || null;
    }
    if (!row && phone && String(phone).trim()) {
      const digits = String(phone).replace(/\D/g, '');
      if (digits.length >= 6) {
        const last9 = digits.length >= 9 ? digits.slice(-9) : digits;
        const r = await query(
          `SELECT first_name, last_name, email, phone, dni FROM module_rapidin_drivers 
           WHERE country = $1 AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE $2 LIMIT 1`,
          [country, '%' + last9]
        );
        row = r.rows[0] || null;
      }
    }
    if (!row) return successResponse(res, null, 'No encontrado');
    return successResponse(res, {
      first_name: toTitleCase(row.first_name || ''),
      last_name: toTitleCase(row.last_name || ''),
      email: row.email || '',
      phone: row.phone || '',
      dni: row.dni || ''
    });
  } catch (e) {
    logger.error('Error admin driver-lookup:', e);
    return errorResponse(res, e.message || 'Error', 400);
  }
});

/** POST /api/admin/driver-save - Guardar/actualizar en module_rapidin_drivers y en drivers (Yego). driver_id puede ser "rapidin-<uuid>" o "driver-<id>".
 *  document_type: 'dni' | 'cedula' = lo que eligió el usuario (8 o 10 dígitos). country = "Trabaja en" (module_rapidin_drivers.country).
 *  update_email_only: true = solo actualizar email, sin validar documento. */
router.post('/driver-save', async (req, res) => {
  try {
    const { driver_id, first_name, last_name, dni, phone, email, country, document_type, update_email_only, update_document_only, park_id: parkIdBody } = req.body;

    if (update_document_only === true) {
      const rawId = (driver_id && typeof driver_id === 'string' && driver_id.trim()) ? driver_id.trim() : '';
      if (!rawId) return errorResponse(res, 'Se necesita el conductor para actualizar el documento', 400);
      const trimmedDni = String(dni || '').trim().replace(/\D/g, '');
      const docType = (document_type || '').toLowerCase().trim() || 'dni';
      const len = trimmedDni.length;
      if (docType === 'dni' && len !== 8) return errorResponse(res, 'DNI debe tener 8 dígitos', 400);
      if (docType === 'cedula' && len !== 10) return errorResponse(res, 'Cédula debe tener 10 dígitos', 400);
      if (rawId.startsWith('rapidin-')) {
        const rapidinUuid = rawId.slice('rapidin-'.length);
        const byId = await query('SELECT id FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [rapidinUuid]);
        if (byId.rows.length === 0) return errorResponse(res, 'Conductor no encontrado', 404);
        await query(
          'UPDATE module_rapidin_drivers SET dni = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [trimmedDni, rapidinUuid]
        );
        return successResponse(res, { saved: true }, 'Documento actualizado');
      }
      if (rawId.startsWith('driver-')) {
        const externalDriverId = rawId.slice('driver-'.length);
        const driversDocType = docType === 'cedula' ? 'cedula' : 'dni';
        try {
          await query(
            'UPDATE drivers SET document_number = $1, document_type = $2 WHERE driver_id = $3',
            [trimmedDni, driversDocType, externalDriverId]
          );
        } catch (errDrivers) {
          logger.warn('driver-save (document only): no se pudo actualizar tabla drivers', errDrivers.message);
        }
        const byExt = await query('SELECT id FROM module_rapidin_drivers WHERE external_driver_id = $1 LIMIT 1', [externalDriverId]);
        if (byExt.rows.length === 0) return errorResponse(res, 'Conductor no encontrado en Rapidín', 404);
        await query(
          'UPDATE module_rapidin_drivers SET dni = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [trimmedDni, byExt.rows[0].id]
        );
        return successResponse(res, { saved: true }, 'Documento actualizado');
      }
      return errorResponse(res, 'driver_id no válido', 400);
    }

    if (update_email_only === true) {
      const mail = (email || '').trim();
      const rawId = (driver_id && typeof driver_id === 'string' && driver_id.trim()) ? driver_id.trim() : '';
      if (!rawId) return errorResponse(res, 'Se necesita el conductor para actualizar el email', 400);
      if (rawId.startsWith('rapidin-')) {
        const rapidinUuid = rawId.slice('rapidin-'.length);
        const byId = await query('SELECT id FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [rapidinUuid]);
        if (byId.rows.length === 0) return errorResponse(res, 'Conductor no encontrado', 404);
        await query(
          'UPDATE module_rapidin_drivers SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [mail, rapidinUuid]
        );
        return successResponse(res, { saved: true }, 'Email actualizado');
      }
      if (rawId.startsWith('driver-')) {
        const externalDriverId = rawId.slice('driver-'.length);
        const byExt = await query('SELECT id FROM module_rapidin_drivers WHERE external_driver_id = $1 LIMIT 1', [externalDriverId]);
        if (byExt.rows.length === 0) return errorResponse(res, 'Conductor no encontrado en Rapidín', 404);
        await query(
          'UPDATE module_rapidin_drivers SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [mail, byExt.rows[0].id]
        );
        return successResponse(res, { saved: true }, 'Email actualizado');
      }
      return errorResponse(res, 'driver_id no válido', 400);
    }

    if (!first_name?.trim() || !last_name?.trim()) return errorResponse(res, 'Nombre y apellido son requeridos', 400);
    const trimmedDni = String(dni || '').trim().replace(/\D/g, '');
    const c = (country || '').trim() || 'PE';
    const docType = (document_type || '').toLowerCase().trim() || (c === 'CO' ? 'cedula' : 'dni');
    const len = trimmedDni.length;
    if (docType === 'dni' && len !== 8) return errorResponse(res, 'DNI debe tener 8 dígitos', 400);
    if (docType === 'cedula' && len !== 10) return errorResponse(res, 'Cédula debe tener 10 dígitos', 400);

    const rawId = (driver_id && typeof driver_id === 'string' && driver_id.trim()) ? driver_id.trim() : '';

    if (rawId.startsWith('rapidin-')) {
      const rapidinUuid = rawId.slice('rapidin-'.length);
      const byId = await query('SELECT id, external_driver_id, dni FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [rapidinUuid]);
      if (byId.rows.length > 0) {
        // Verificar si el nuevo DNI ya existe en otro registro (para evitar duplicados)
        const currentDni = byId.rows[0].dni;
        if (trimmedDni !== currentDni) {
          const existingWithDni = await query(
            'SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 AND id != $3 LIMIT 1',
            [trimmedDni, c, rapidinUuid]
          );
          if (existingWithDni.rows.length > 0) {
            return errorResponse(res, 'Ya existe otro conductor con ese documento en el sistema', 400);
          }
        }
        
        // Buscar external_driver_id en tabla drivers por DNI si no lo tiene
        let extId = byId.rows[0].external_driver_id;
        if (!extId && trimmedDni) {
          try {
            const driverLookup = await query(
              'SELECT driver_id, park_id FROM drivers WHERE document_number = $1 LIMIT 1',
              [trimmedDni]
            );
            if (driverLookup.rows.length > 0) {
              extId = driverLookup.rows[0].driver_id;
              const parkId = driverLookup.rows[0].park_id || null;
              // Actualizar external_driver_id y park_id en module_rapidin_drivers
              await query(
                `UPDATE module_rapidin_drivers SET external_driver_id = $1, park_id = COALESCE($2, park_id), updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
                [extId, parkId, rapidinUuid]
              );
              logger.info(`driver-save: external_driver_id ${extId} encontrado por DNI ${trimmedDni} y guardado`);
            }
          } catch (errLookup) {
            logger.warn('driver-save: error buscando driver_id por DNI', errLookup.message);
          }
        }
        
        await query(
          `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, dni = $3, phone = $4, email = $5, country = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7`,
          [(first_name || '').trim(), (last_name || '').trim(), trimmedDni, (phone || '').trim(), (email || '').trim(), c, rapidinUuid]
        );
        // Si tiene external_driver_id, actualizar tabla drivers (documento y tipo)
        if (extId) {
          try {
            await query(
              `UPDATE drivers SET first_name = $1, last_name = $2, phone = $3, document_number = $4, document_type = $5 WHERE driver_id = $6`,
              [(first_name || '').trim(), (last_name || '').trim(), (phone || '').trim(), trimmedDni, docType, extId]
            );
          } catch (errDrivers) {
            logger.warn('driver-save (rapidin): no se pudo actualizar tabla drivers', errDrivers.message);
          }
        }
        return successResponse(res, { saved: true, driver_id: rapidinUuid }, 'Conductor guardado');
      }
    }

    if (rawId.startsWith('driver-')) {
      const externalDriverId = rawId.slice('driver-'.length);
      try {
        const driversDocType = docType === 'cedula' ? 'cedula' : 'dni';
        await query(
          `UPDATE drivers SET first_name = $1, last_name = $2, phone = $3, document_number = $4, document_type = $5 WHERE driver_id = $6`,
          [(first_name || '').trim(), (last_name || '').trim(), (phone || '').trim(), trimmedDni, driversDocType, externalDriverId]
        );
      } catch (errDrivers) {
        logger.warn('driver-save: no se pudo actualizar tabla drivers', errDrivers.message);
      }
      /* El correo solo se guarda en module_rapidin_drivers, no en la tabla drivers (Yego). */
      const byExt = await query(
        'SELECT id, dni FROM module_rapidin_drivers WHERE external_driver_id = $1 LIMIT 1',
        [externalDriverId]
      );
      if (byExt.rows.length > 0) {
        // Verificar si el nuevo DNI ya existe en otro registro
        const currentDni = byExt.rows[0].dni;
        if (trimmedDni !== currentDni) {
          const existingWithDni = await query(
            'SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 AND id != $3 LIMIT 1',
            [trimmedDni, c, byExt.rows[0].id]
          );
          if (existingWithDni.rows.length > 0) {
            return errorResponse(res, 'Ya existe otro conductor con ese documento en el sistema', 400);
          }
        }
        await query(
          `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, dni = $3, phone = $4, email = $5, country = $6, external_driver_id = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8`,
          [(first_name || '').trim(), (last_name || '').trim(), trimmedDni, (phone || '').trim(), (email || '').trim(), c, externalDriverId, byExt.rows[0].id]
        );
      } else {
        // Verificar si ya existe un conductor con ese DNI antes de crear
        const existingWithDni = await query(
          'SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1',
          [trimmedDni, c]
        );
        if (existingWithDni.rows.length > 0) {
          // Ya existe, actualizar y enlazar con external_driver_id
          await query(
            `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, phone = $3, email = $4, external_driver_id = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
            [(first_name || '').trim(), (last_name || '').trim(), (phone || '').trim(), (email || '').trim(), externalDriverId, existingWithDni.rows[0].id]
          );
        } else {
          const parkNorm = (parkIdBody != null && parkIdBody !== '') ? String(parkIdBody).trim() : null;
          await createOrUpdateDriver({
            dni: trimmedDni,
            country: c,
            first_name: (first_name || '').trim(),
            last_name: (last_name || '').trim(),
            phone: (phone || '').trim(),
            email: (email || '').trim(),
            yego_premium: false,
            park_id: parkNorm
          });
          const after = await query('SELECT id FROM module_rapidin_drivers WHERE dni = $1 AND country = $2 LIMIT 1', [trimmedDni, c]);
          if (after.rows.length > 0) {
            await query(
              'UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
              [externalDriverId, after.rows[0].id]
            );
          }
        }
      }
      return successResponse(res, { saved: true, driver_id: externalDriverId }, 'Conductor guardado');
    }

    const parkNorm = (parkIdBody != null && parkIdBody !== '') ? String(parkIdBody).trim() : null;
    await createOrUpdateDriver({
      dni: trimmedDni,
      country: c,
      first_name: (first_name || '').trim(),
      last_name: (last_name || '').trim(),
      phone: (phone || '').trim(),
      email: (email || '').trim(),
      yego_premium: false,
      park_id: parkNorm
    });
    
    // Buscar external_driver_id en tabla drivers por DNI y actualizarlo
    if (trimmedDni) {
      try {
        const driverLookup = await query(
          'SELECT driver_id, park_id FROM drivers WHERE document_number = $1 LIMIT 1',
          [trimmedDni]
        );
        if (driverLookup.rows.length > 0) {
          const extId = driverLookup.rows[0].driver_id;
          const parkId = driverLookup.rows[0].park_id || null;
          await query(
            `UPDATE module_rapidin_drivers SET external_driver_id = $1, park_id = COALESCE($2, park_id), updated_at = CURRENT_TIMESTAMP WHERE dni = $3 AND country = $4`,
            [extId, parkId, trimmedDni, c]
          );
          logger.info(`driver-save: external_driver_id ${extId} encontrado por DNI ${trimmedDni} y guardado`);
        }
      } catch (errLookup) {
        logger.warn('driver-save: error buscando driver_id por DNI', errLookup.message);
      }
    }
    
    return successResponse(res, { saved: true }, 'Conductor guardado');
  } catch (e) {
    logger.error('Error admin driver-save:', e);
    return errorResponse(res, e.message || 'Error al guardar conductor', 400);
  }
});

/** DELETE /api/admin/loan/:loanId - Eliminar todo lo relacionado con un préstamo (para poder generar uno nuevo) */
router.delete('/loan/:loanId', async (req, res) => {
  try {
    const loanId = (req.params.loanId || '').trim();
    if (!loanId) return errorResponse(res, 'ID de préstamo requerido', 400);

    const loanRow = await query('SELECT id, request_id FROM module_rapidin_loans WHERE id = $1 LIMIT 1', [loanId]);
    if (loanRow.rows.length === 0) return errorResponse(res, 'Préstamo no encontrado', 404);
    const requestId = loanRow.rows[0].request_id;

    await query(
      `DELETE FROM module_rapidin_voucher_installments WHERE voucher_id IN (SELECT id FROM module_rapidin_payment_vouchers WHERE loan_id = $1)`,
      [loanId]
    );
    await query('DELETE FROM module_rapidin_payment_vouchers WHERE loan_id = $1', [loanId]);
    await query(
      `DELETE FROM module_rapidin_payment_installments WHERE payment_id IN (SELECT id FROM module_rapidin_payments WHERE loan_id = $1)`,
      [loanId]
    );
    await query('DELETE FROM module_rapidin_payments WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_documents WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_auto_payment_log WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_installments WHERE loan_id = $1', [loanId]);
    await query('DELETE FROM module_rapidin_loans WHERE id = $1', [loanId]);
    if (requestId) {
      await query('DELETE FROM module_rapidin_documents WHERE request_id = $1', [requestId]);
      await query('DELETE FROM module_rapidin_loan_requests WHERE id = $1', [requestId]);
    }

    return successResponse(res, { deleted: true, loanId }, 'Préstamo y datos relacionados eliminados. Puedes generar uno nuevo.');
  } catch (e) {
    logger.error('Error admin DELETE loan:', e);
    return errorResponse(res, e.message || 'Error al eliminar', 400);
  }
});

/** GET /api/admin/loan-offer?country=PE - Oferta ciclo 1 para el país (para nueva solicitud desde admin).
 *  No se valida mínimo de viajes; esa condición aplica solo al flujo conductor (GET /driver/loan-offer). */
router.get('/loan-offer', async (req, res) => {
  try {
    const { country } = req.query;
    if (!country) return errorResponse(res, 'País requerido', 400);
    const row = await query(
      `SELECT cycle, max_credit_line, requires_guarantor FROM module_rapidin_cycle_config 
       WHERE country = $1 AND cycle = 1 AND active = true LIMIT 1`,
      [country]
    );
    if (row.rows.length === 0) return errorResponse(res, 'No hay configuración para este país', 400);
    const r = row.rows[0];
    return successResponse(res, {
      cycle: parseInt(r.cycle, 10),
      maxAmount: parseFloat(r.max_credit_line),
      requiresGuarantor: r.requires_guarantor === true
    });
  } catch (e) {
    logger.error('Error admin loan-offer:', e);
    return errorResponse(res, e.message || 'Error', 400);
  }
});

/** POST /api/admin/loan-simulate - Simular opciones sin request_id (para nueva solicitud admin) */
router.post('/loan-simulate', async (req, res) => {
  try {
    const { country, requested_amount, cycle } = req.body;
    if (!country || !requested_amount) {
      return errorResponse(res, 'País y monto solicitado son requeridos', 400);
    }
    const amount = parseFloat(requested_amount);
    if (isNaN(amount) || amount < 10) {
      return errorResponse(res, 'Monto mínimo 10', 400);
    }
    const conditions = await query(
      'SELECT * FROM module_rapidin_loan_conditions WHERE country = $1 AND active = true ORDER BY version DESC LIMIT 1',
      [country]
    );
    if (conditions.rows.length === 0) {
      return errorResponse(res, 'No hay condiciones de préstamo configuradas para este país', 400);
    }
    const cycleNum = cycle != null ? parseInt(cycle, 10) : 1;
    const options = await simulateLoanOptions(amount, country, cycleNum, conditions.rows[0]);
    return successResponse(res, options, 'Opciones generadas');
  } catch (error) {
    logger.error('Error admin loan-simulate:', error);
    return errorResponse(res, error.message || 'Error al simular', 400);
  }
});

/** POST /api/admin/loan-request - Crear solicitud desde admin (beneficiario: nombre, DNI, teléfono + resto + archivos) */
router.post('/loan-request', uploadLoanDocFields, async (req, res) => {
  try {
    const {
      first_name,
      last_name,
      dni,
      phone,
      country,
      email,
      requested_amount,
      purpose,
      deposit_type,
      bank,
      account_type,
      account_number,
      contact_name,
      contact_dni,
      contact_phone,
      contact_relationship,
      contact_signature,
      selected_option,
      contract_signature,
      park_id: parkIdBody,
      external_driver_id: externalDriverIdBody
    } = req.body;

    if (!first_name?.trim() || !last_name?.trim() || !dni?.trim() || !country) {
      return errorResponse(res, 'Nombre, apellido, DNI y país son requeridos', 400);
    }
    if (!requested_amount || !purpose) {
      return errorResponse(res, 'Monto solicitado y propósito son requeridos', 400);
    }

    const dniValidation = await validateDNI(dni.trim());
    if (!dniValidation.valid) {
      return errorResponse(res, dniValidation.message, 400);
    }

    if (contact_dni && (contact_dni || '').toString().trim() === (dni || '').toString().trim()) {
      return errorResponse(res, 'El DNI del contacto no puede ser el mismo que el del solicitante', 400);
    }
    if (contact_phone && phone) {
      const phoneDigits = (phone || '').toString().replace(/\D/g, '');
      const contactPhoneDigits = (contact_phone || '').toString().replace(/\D/g, '');
      if (contactPhoneDigits && phoneDigits && contactPhoneDigits === phoneDigits) {
        return errorResponse(res, 'El teléfono del contacto no puede ser el mismo que el del solicitante', 400);
      }
    }

    const parkIdNorm = (parkIdBody != null && parkIdBody !== '') ? String(parkIdBody).trim() : null;

    let driver = null;
    if (parkIdNorm) {
      // Buscar por dni+country+park_id o por phone+country+park_id (el único en BD es phone+country+park_id).
      driver = await getDriverByPark(dni.trim(), country, parkIdNorm);
      if (!driver && phone) {
        driver = await getDriverByPhoneAndPark(phone.trim(), country, parkIdNorm);
      }
      if (driver) {
        await query(
          `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, dni = $3, phone = $4, email = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
          [(first_name || '').trim(), (last_name || '').trim(), dni.trim(), (phone || '').trim(), (email || '').trim(), driver.id]
        );
        driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [driver.id]).then(r => r.rows[0] || null);
      } else {
        // No existe fila para esta flota: INSERT (evita duplicate key en idx_rapidin_drivers_phone_country_park).
        driver = await createDriverForPark({
          dni: dni.trim(),
          country,
          first_name: (first_name || '').trim(),
          last_name: (last_name || '').trim(),
          phone: (phone || '').trim(),
          email: (email || '').trim(),
          yego_premium: false,
          park_id: parkIdNorm
        });
      }
      if (driver && externalDriverIdBody && String(externalDriverIdBody).trim()) {
        await query(
          'UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [String(externalDriverIdBody).trim(), driver.id]
        );
        driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [driver.id]).then(r => r.rows[0] || null);
      }
    }
    if (!driver) {
      driver = await getDriver(dni.trim(), country);
      if (driver) {
        await query(
          `UPDATE module_rapidin_drivers SET first_name = $1, last_name = $2, phone = $3, email = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
          [(first_name || '').trim(), (last_name || '').trim(), (phone || '').trim(), (email || '').trim(), driver.id]
        );
        driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [driver.id]).then(r => r.rows[0] || null);
      } else {
        await createOrUpdateDriver({
          dni: dni.trim(),
          country,
          first_name: (first_name || '').trim(),
          last_name: (last_name || '').trim(),
          phone: (phone || '').trim(),
          email: (email || '').trim(),
          yego_premium: false,
          park_id: parkIdNorm
        });
        driver = parkIdNorm
          ? await getDriverByPark(dni.trim(), country, parkIdNorm)
          : await getDriver(dni.trim(), country);
      }
      if (driver && externalDriverIdBody && String(externalDriverIdBody).trim()) {
        await query(
          'UPDATE module_rapidin_drivers SET external_driver_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [String(externalDriverIdBody).trim(), driver.id]
        );
        driver = await query('SELECT * FROM module_rapidin_drivers WHERE id = $1 LIMIT 1', [driver.id]).then(r => r.rows[0] || null);
      }
    }
    const driverId = driver.id;

    const driverCycleResult = await query('SELECT cycle FROM module_rapidin_drivers WHERE id = $1', [driverId]);
    const driverCycle = driverCycleResult.rows[0]?.cycle != null ? parseInt(driverCycleResult.rows[0].cycle, 10) : 1;
    const cycleConfigResult = await query(
      `SELECT requires_guarantor FROM module_rapidin_cycle_config WHERE country = $1 AND cycle = $2 AND active = true LIMIT 1`,
      [country, driverCycle]
    );
    // Ciclo >= 7 siempre requiere garante; si no, según configuración del ciclo
    const requiresGuarantor = driverCycle >= 7 || cycleConfigResult.rows[0]?.requires_guarantor === true;

    if (requiresGuarantor) {
      if (!contact_name?.trim() || !contact_dni?.trim() || !contact_phone?.trim()) {
        return errorResponse(res, 'Para este ciclo se requiere garante. Completa nombre, DNI y teléfono del garante.', 400);
      }
      if (!contact_signature) {
        return errorResponse(res, 'Se requiere la firma del garante.', 400);
      }
      if (!req.files?.contact_front_photo?.[0]) {
        return errorResponse(res, 'Se requiere la foto del DNI frontal del garante.', 400);
      }
    }

    const loanRequest = await createLoanRequest(
      {
        driver_id: driverId,
        country,
        requested_amount: parseFloat(requested_amount),
        observations: JSON.stringify({
          purpose,
          deposit_type: deposit_type || 'yango',
          bank: bank || '',
          account_type: account_type || '',
          account_number: account_number || '',
          contact_name: contact_name || '',
          contact_dni: contact_dni || '',
          contact_phone: contact_phone || '',
          contact_relationship: contact_relationship || '',
          selected_option: selected_option ? parseInt(selected_option, 10) : null
        })
      },
      null,
      { createdByAdmin: true }
    );

    const slug = (name) => (name || '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_áéíóúÁÉÍÓÚñÑ\-]/g, '').slice(0, 80) || 'sin_nombre';
    const driverNameSlug = slug([first_name, last_name].filter(Boolean).join(' '));
    const contactNameSlug = slug(contact_name || '');
    const requestId = loanRequest.id;

    const uploadAndInsertDoc = async (type, fileName, buffer, mimetype = 'image/png', signed = false) => {
      const url = await uploadFileToMedia({ buffer, mimetype, originalname: fileName });
      await pool.query(
        `INSERT INTO module_rapidin_documents (loan_id, request_id, type, file_name, file_path, signed, signed_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6)`,
        [requestId, type, fileName, url, signed, signed ? new Date() : null]
      );
    };

    const toBuffer = (source, kind) => {
      if (!source) return null;
      // memoryStorage: el archivo viene con buffer directamente
      if (kind === 'file' && source.buffer) {
        return { buffer: source.buffer, mimetype: source.mimetype || 'image/png' };
      }
      // base64: convertir a buffer
      const base64Data = (source || '').replace(/^data:image\/\w+;base64,/, '');
      if (!base64Data) return null;
      return { buffer: Buffer.from(base64Data, 'base64'), mimetype: 'image/png' };
    };

    const firmaConductorName = `firma_conductor_${driverNameSlug}_${requestId}.png`;
    const firmaGaranteName = `firma_garante_${contactNameSlug}_${requestId}.png`;
    const conductorSigSource = req.files?.contract_signature?.[0] || contract_signature;

    const docs = [
      [req.files?.id_document?.[0], 'id_document', `id_document_${driverNameSlug}_${requestId}.png`, 'file', false],
      [conductorSigSource, 'contract_signature', firmaConductorName, conductorSigSource?.buffer ? 'file' : 'base64', true]
    ];
    if (requiresGuarantor) {
      docs.push(
        [req.files?.contact_front_photo?.[0], 'contact_front_photo', `dni_garante_${contactNameSlug}_${requestId}.png`, 'file', false],
        [contact_signature, 'contact_signature', firmaGaranteName, 'base64', true]
      );
    }

    for (const [source, type, fileName, kind, signed] of docs) {
      const parsed = toBuffer(source, kind);
      if (!parsed) continue;
      await uploadAndInsertDoc(type, fileName, parsed.buffer, parsed.mimetype, signed);
    }

    return successResponse(res, { requestId: loanRequest.id }, 'Solicitud creada exitosamente', 201);
  } catch (error) {
    logger.error('Error creando solicitud desde admin:', error);
    return errorResponse(res, error.message || 'Error al crear la solicitud', 500);
  }
});

export default router;
