import { query } from '../config/database.js';

/**
 * Obtiene el tipo de cambio vigente para un país (1 USD = X moneda_local).
 * @param {string} country - 'PE' | 'CO'
 * @returns {Promise<{ valor_usd_a_local: number, moneda_local: string } | null>}
 */
export async function getTipoCambioByCountry(country) {
  if (!country || !['PE', 'CO'].includes(String(country).toUpperCase())) {
    return null;
  }
  const res = await query(
    'SELECT valor_usd_a_local, moneda_local FROM module_miauto_tipo_cambio WHERE country = $1 LIMIT 1',
    [String(country).toUpperCase()]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    valor_usd_a_local: parseFloat(row.valor_usd_a_local) || 0,
    moneda_local: row.moneda_local || (country === 'PE' ? 'PEN' : 'COP'),
  };
}

/**
 * Establece o actualiza el tipo de cambio para un país.
 * @param {string} country - 'PE' | 'CO'
 * @param {number} valor_usd_a_local - unidades de moneda local por 1 USD
 * @param {string} moneda_local - 'PEN' | 'COP'
 * @param {string} [userId] - opcional
 * @returns {Promise<{ country, moneda_local, valor_usd_a_local, updated_at }>}
 */
export async function setTipoCambio(country, valor_usd_a_local, moneda_local, userId = null) {
  if (!country || !['PE', 'CO'].includes(String(country).toUpperCase())) {
    throw new Error('country debe ser PE o CO');
  }
  const moneda = String(moneda_local).toUpperCase() === 'COP' ? 'COP' : 'PEN';
  const valor = Math.max(0, parseFloat(valor_usd_a_local) || 0);

  await query(
    `INSERT INTO module_miauto_tipo_cambio (country, moneda_local, valor_usd_a_local, updated_at, updated_by)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
     ON CONFLICT (country) DO UPDATE SET
       moneda_local = EXCLUDED.moneda_local,
       valor_usd_a_local = EXCLUDED.valor_usd_a_local,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = EXCLUDED.updated_by`,
    [String(country).toUpperCase(), moneda, valor, userId || null]
  );

  const row = (await query('SELECT country, moneda_local, valor_usd_a_local, updated_at FROM module_miauto_tipo_cambio WHERE country = $1', [String(country).toUpperCase()])).rows[0];
  return {
    country: row.country,
    moneda_local: row.moneda_local,
    valor_usd_a_local: parseFloat(row.valor_usd_a_local),
    updated_at: row.updated_at,
  };
}

/**
 * Lista tipo de cambio de todos los países (para admin config).
 * @returns {Promise<Array<{ country, moneda_local, valor_usd_a_local, updated_at }>>}
 */
export async function listTiposCambio() {
  const res = await query('SELECT country, moneda_local, valor_usd_a_local, updated_at FROM module_miauto_tipo_cambio ORDER BY country');
  return (res.rows || []).map((r) => ({
    country: r.country,
    moneda_local: r.moneda_local,
    valor_usd_a_local: parseFloat(r.valor_usd_a_local) || 0,
    updated_at: r.updated_at,
  }));
}
