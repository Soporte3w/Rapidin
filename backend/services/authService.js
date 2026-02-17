import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';
import { generateToken } from '../config/jwt.js';
import { logger } from '../utils/logger.js';
import { sendSMS } from './notificationService.js';
import { getPartnerNameById } from './partnersService.js';
import { normalizePhoneForDb } from '../utils/helpers.js';

export const login = async (email, password) => {
    const result = await query(
        'SELECT id, email, password_hash, first_name, last_name, role, country, active FROM module_rapidin_users WHERE email = $1',
        [email]
    );

    if (result.rows.length === 0) {
        throw new Error('Credenciales inválidas');
    }

    const user = result.rows[0];

    if (!user.active) {
        throw new Error('Usuario inactivo');
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
        throw new Error('Credenciales inválidas');
    }

    await query(
        'UPDATE module_rapidin_users SET last_access = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
    );

    const token = generateToken(user.id, user.email, user.role);

    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
            country: user.country
        }
    };
};

export const getCurrentUser = async (userId) => {
    const result = await query(
        `SELECT id, email, first_name, last_name, role, country, active, last_access, created_at 
     FROM module_rapidin_users WHERE id = $1`,
        [userId]
    );

    if (result.rows.length === 0) {
        throw new Error('Usuario no encontrado');
    }

    return result.rows[0];
};

// Almacenamiento temporal de códigos OTP (en producción usar Redis o base de datos)
const otpStore = new Map();

// Normalizar teléfono para usar siempre la misma clave (evitar "no encontrado" por formato distinto)
function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return phone;
    const digits = phone.replace(/\s/g, '').replace(/\D/g, '');
    return digits ? `+${digits}` : phone.trim();
}

export const sendOTP = async (phone, country) => {
    const normalizedPhone = normalizePhone(phone);
    // LOG para debug - ver exactamente qué llega
    logger.info(`[DEBUG sendOTP] Buscando teléfono: "${normalizedPhone}" (length: ${normalizedPhone.length}), country: ${country}`);
    logger.info(`[DEBUG sendOTP] Phone bytes: ${Buffer.from(phone).toString('hex')}`);

    // Primero validar si el conductor existe en la tabla drivers
    // Los números en la BD están guardados CON el +
    // work_status debe ser 'working' (fired = desactivado)
    // Si hay duplicados, tomar el que esté 'working'

    const driverResult = await query(
        `SELECT phone, license_country, work_status, first_name, last_name, document_number 
         FROM drivers 
         WHERE phone = $1 AND work_status = 'working'
         LIMIT 1`,
        [normalizedPhone]
    );

    logger.info(`[DEBUG sendOTP] Resultados encontrados: ${driverResult.rows.length}`);

    if (driverResult.rows.length === 0) {
        // Buscar sin filtro de work_status para debug
        const debugResult = await query(
            `SELECT phone, work_status FROM drivers WHERE phone = $1 LIMIT 3`,
            [normalizedPhone]
        );
        logger.error(`[DEBUG] Registros en BD con ese phone: ${JSON.stringify(debugResult.rows)}`);
        throw new Error('Número de teléfono no registrado o conductor inactivo');
    }

    const driver = driverResult.rows[0];

    // Generar código de 6 dígitos
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 60 * 1000; // 1 minuto

    // Guardar código (clave normalizada para que verifyOTP lo encuentre)
    otpStore.set(normalizedPhone, {
        code,
        expiresAt,
        attempts: 0,
        country,
        driverData: driver
    });

    // Enviar WhatsApp con el código usando el API de 3W
    const message = `Hola ${driver.first_name}! 👋\n\nTu código de verificación para Yego Rapidín es: *${code}*\n\nVálido por 1 minuto.\nNo compartas este código con nadie.`;

    try {
        const phoneWithPlus = normalizedPhone.startsWith('+') ? normalizedPhone : `+${normalizedPhone}`;

        const whatsappInstanceId = process.env.WHATSAPP_OTP_TOKEN || process.env.WHATSAPP_INSTANCE_ID;
        if (!whatsappInstanceId) {
            throw new Error('WHATSAPP_OTP_TOKEN (o WHATSAPP_INSTANCE_ID) no configurado en .env');
        }
        const response = await fetch(`https://api-wsp.3w.pe/instances/${whatsappInstanceId}/messages/text`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${whatsappInstanceId}`,
            },
            body: JSON.stringify({
                phone: phoneWithPlus,
                message: message
            })
        });

        if (!response.ok) {
            throw new Error(`Error en API WhatsApp: ${response.statusText}`);
        }

        logger.info(`Código OTP enviado por WhatsApp a ${phoneWithPlus}`);
    } catch (error) {
        logger.error('Error enviando código OTP por WhatsApp:', error);
        // En desarrollo, loguear el código para facilitar pruebas
        if (process.env.NODE_ENV === 'development') {
            logger.info(`[DESARROLLO] Código OTP para ${normalizedPhone}: ${code}`);
        }
        throw new Error('Error al enviar el código. Intenta nuevamente.');
    }

    return { success: true, message: 'Código enviado por WhatsApp' };
};

export const verifyOTP = async (phone, code, country) => {
    const normalizedPhone = normalizePhone(phone);
    const stored = otpStore.get(normalizedPhone);

    if (!stored) {
        throw new Error('Código no encontrado o expirado. Solicita un nuevo código.');
    }

    // Rechazar código vencido: no permitir ingresar con un código que ya expiró
    if (Date.now() > stored.expiresAt) {
        otpStore.delete(normalizedPhone);
        throw new Error('Código expirado. Solicita un nuevo código para continuar.');
    }

    if (stored.attempts >= 5) {
        otpStore.delete(normalizedPhone);
        throw new Error('Demasiados intentos fallidos. Solicita un nuevo código.');
    }

    if (stored.code !== code) {
        stored.attempts++;
        throw new Error('Código inválido');
    }

    // Código válido, eliminar para que no se pueda reutilizar
    otpStore.delete(normalizedPhone);

    // Todos los registros del conductor con work_status = 'working' (una fila por flota en tabla drivers)
    let driverResult;
    try {
        driverResult = await query(
            `SELECT car_id, driver_id, phone, license_country, first_name, last_name, park_id,
                    document_number, document_type, work_status, rating, account_balance
             FROM drivers 
             WHERE phone = $1 AND work_status = 'working'
             ORDER BY park_id NULLS LAST`,
            [normalizedPhone]
        );
    } catch (e) {
        if (e.code === '42703' || (e.message && e.message.includes('document_type'))) {
            driverResult = await query(
                `SELECT car_id, driver_id, phone, license_country, first_name, last_name, park_id,
                        document_number, work_status, rating, account_balance
                 FROM drivers 
                 WHERE phone = $1 AND work_status = 'working'
                 ORDER BY park_id NULLS LAST`,
                [normalizedPhone]
            );
            if (driverResult.rows.length > 0) driverResult.rows[0].document_type = null;
        } else throw e;
    }

    if (driverResult.rows.length === 0) {
        throw new Error('Conductor no encontrado o inactivo');
    }

    const driver = driverResult.rows[0];

    // Flotas disponibles: cada fila en drivers (working) con nombre de flota
    const flotas = [];
    for (const row of driverResult.rows) {
        const parkId = row.park_id || null;
        const driverId = row.driver_id != null ? String(row.driver_id) : null;
        let flotaName = null;
        if (parkId) {
            try {
                flotaName = await getPartnerNameById(parkId);
            } catch {
                flotaName = parkId;
            }
        }
        flotas.push({
            driver_id: driverId,
            park_id: parkId,
            flota_name: flotaName || 'Sin flota'
        });
    }

    // Verificar si tiene préstamo activo en module_rapidin_loans
    const loanResult = await query(
        `SELECT l.id, l.status, l.pending_balance, l.disbursed_amount
         FROM module_rapidin_loans l
         JOIN module_rapidin_drivers rd ON rd.id = l.driver_id
         WHERE rd.phone = $1 AND l.status = 'active'
         LIMIT 1`,
        [normalizedPhone]
    );

    const activeLoan = loanResult.rows.length > 0 ? loanResult.rows[0] : null;

    const countryCode = driver.license_country === 'per' ? 'PE' : 'CO';

    // Crear objeto de usuario para el token (email no se consulta aquí; el conductor lo completa en Mi Perfil)
    const user = {
        phone: driver.phone,
        first_name: driver.first_name,
        last_name: driver.last_name,
        role: 'driver',
        country: countryCode,
        document_number: driver.document_number,
        document_type: driver.document_type,
        rating: driver.rating,
        account_balance: driver.account_balance,
        has_active_loan: !!activeLoan
    };

    // Generar token con phone y country para conductor
    const token = jwt.sign(
        {
            phone: user.phone,
            country: user.country,
            role: 'driver'
        },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
    );

    // driver_id = id del conductor (persona); car_id = id del registro en tabla drivers (asignación/vehículo)
    const driverId = driver.driver_id != null ? String(driver.driver_id) : null;
    const carId = driver.car_id != null ? String(driver.car_id) : null;

    // Devolver el id (UUID) de module_rapidin_drivers si el número ya está registrado — para localStorage
    let rapidin_driver_id = null;
    try {
        const phoneForDb = normalizePhoneForDb(user.phone, countryCode);
        const digitsOnly = (user.phone || '').toString().replace(/\D/g, '');
        const rapidinRow = await query(
            `SELECT id FROM module_rapidin_drivers
             WHERE country = $1
               AND (phone = $2 OR phone = $3 OR REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g') = $4)
             LIMIT 1`,
            [countryCode, phoneForDb, user.phone, digitsOnly]
        );
        if (rapidinRow.rows.length > 0) {
            rapidin_driver_id = rapidinRow.rows[0].id != null ? String(rapidinRow.rows[0].id) : null;
        }
    } catch (e) {
        logger.warn('No se pudo buscar id de module_rapidin_drivers al login:', e.message);
    }

    return {
        token,
        user: {
            phone: user.phone,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
            country: user.country,
            document_number: user.document_number,
            document_type: user.document_type,
            rating: user.rating,
            has_active_loan: user.has_active_loan,
            active_loan: activeLoan,
            driver_id: driverId,
            car_id: carId,
            rapidin_driver_id: rapidin_driver_id
        },
        flotas,
        rapidin_driver_id: rapidin_driver_id
    };
};







