import { logger } from '../utils/logger.js';

const EVOLUTION_GO_BASE_URL = (process.env.EVOLUTION_GO_BASE_URL || 'https://go.yego.pro').replace(/\/+$/, '');
const DEFAULT_DELAY_MS = Number(process.env.EVOLUTION_GO_WHATSAPP_DELAY_MS || 1200);

function normalizeEvolutionGoNumber(phone, defaultCountry = 'PE') {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length >= 10 && (digits.startsWith('51') || digits.startsWith('57'))) return digits;
    if (defaultCountry === 'PE' && digits.length === 9) return `51${digits}`;
    if (defaultCountry === 'CO' && digits.length === 10) return `57${digits}`;
    return digits;
}

function requireToken(token, tokenName = 'EVOLUTION_GO_TOKEN') {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
        return { ok: false, error: `${tokenName} no configurado` };
    }
    return { ok: true, token: cleanToken };
}

async function parseEvolutionGoResponse(response) {
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    const message = data?.message || data?.error || text || `HTTP ${response.status}`;
    return { text, data, message };
}

async function evolutionGoRequest(path, { token, tokenName, body }) {
    const tokenCheck = requireToken(token, tokenName);
    if (!tokenCheck.ok) return { success: false, error: tokenCheck.error };

    const url = `${EVOLUTION_GO_BASE_URL}${path}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                apikey: tokenCheck.token,
                Authorization: `Bearer ${tokenCheck.token}`,
            },
            body: JSON.stringify(body),
        });

        const parsed = await parseEvolutionGoResponse(response);
        if (!response.ok) {
            logger.error(`Evolution GO WhatsApp error: ${response.status} ${parsed.text}`);
            return { success: false, error: parsed.message, status: response.status, data: parsed.data };
        }
        return { success: true, status: response.status, data: parsed.data };
    } catch (error) {
        logger.error('Error consultando Evolution GO WhatsApp:', error);
        return { success: false, error: error.message || 'Error consultando Evolution GO' };
    }
}

export async function sendEvolutionGoTextMessage(phone, message, {
    token,
    tokenName = 'EVOLUTION_GO_TOKEN',
    defaultCountry = 'PE',
    delay = DEFAULT_DELAY_MS,
} = {}) {
    const number = normalizeEvolutionGoNumber(phone, defaultCountry);
    if (!number) return { success: false, error: 'Número de teléfono inválido' };
    if (!String(message || '').trim()) return { success: false, error: 'Mensaje requerido' };

    return await evolutionGoRequest('/send/text', {
        token,
        tokenName,
        body: {
            number,
            text: String(message),
            delay,
        },
    });
}

export async function sendEvolutionGoMediaMessage(phone, {
    caption = '',
    fileUrl,
    fileName = 'documento.pdf',
    type = 'document',
    defaultCountry = 'PE',
    delay = DEFAULT_DELAY_MS,
} = {}, {
    token,
    tokenName = 'EVOLUTION_GO_TOKEN',
} = {}) {
    const number = normalizeEvolutionGoNumber(phone, defaultCountry);
    if (!number) return { success: false, error: 'Número de teléfono inválido' };
    if (!fileUrl) return { success: false, error: 'URL del archivo requerida' };

    return await evolutionGoRequest('/send/media', {
        token,
        tokenName,
        body: {
            number,
            type,
            url: fileUrl,
            caption: caption || '',
            filename: fileName,
            delay,
        },
    });
}

export async function getEvolutionGoInstanceStatus({ token, tokenName = 'EVOLUTION_GO_TOKEN' } = {}) {
    const tokenCheck = requireToken(token, tokenName);
    if (!tokenCheck.ok) return { success: false, error: tokenCheck.error };

    try {
        const response = await fetch(`${EVOLUTION_GO_BASE_URL}/instance/status`, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                apikey: tokenCheck.token,
                Authorization: `Bearer ${tokenCheck.token}`,
            },
        });
        const parsed = await parseEvolutionGoResponse(response);
        if (!response.ok) {
            return { success: false, error: parsed.message, status: response.status, data: parsed.data };
        }
        return { success: true, status: response.status, data: parsed.data };
    } catch (error) {
        return { success: false, error: error.message || 'Error consultando estado Evolution GO' };
    }
}
