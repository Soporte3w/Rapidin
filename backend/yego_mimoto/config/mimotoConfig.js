const truthy = new Set(['1', 'true', 'yes', 'on']);

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  return value == null ? fallback : truthy.has(String(value).trim().toLowerCase());
}

export const MIMOTO_CONFIG = Object.freeze({
  product: 'mimoto',
  country: 'CO',
  defaultCurrency: 'COP',
  get timezone() { return process.env.MIMOTO_TIMEZONE || 'America/Bogota'; },
  get enabled() { return envBoolean('MIMOTO_ENABLED', false); },
  get automationEnabled() { return envBoolean('MIMOTO_AUTOMATION_ENABLED', false); },
  get fleetWithdrawEnabled() { return envBoolean('MIMOTO_FLEET_WITHDRAW_ENABLED', false); },
  get contratosBucket() { return process.env.MIMOTO_CONTRATOS_BUCKET || 'mimoto-contratos'; },
  get comprobantesBucket() { return process.env.MIMOTO_COMPROBANTES_BUCKET || 'mimoto-comprobantes'; },
});

export function getMimotoPublicConfig() {
  return {
    product: MIMOTO_CONFIG.product,
    country: MIMOTO_CONFIG.country,
    timezone: MIMOTO_CONFIG.timezone,
    default_currency: MIMOTO_CONFIG.defaultCurrency,
    enabled: MIMOTO_CONFIG.enabled,
    automation_enabled: MIMOTO_CONFIG.automationEnabled,
    fleet_withdraw_enabled: MIMOTO_CONFIG.fleetWithdrawEnabled,
    billing_enabled: false,
  };
}
