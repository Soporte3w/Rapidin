import { MIMOTO_CONFIG } from '../config/mimotoConfig.js';

export function mimotoFleetCookie() {
  return String(process.env.MIMOTO_FLEET_COOKIE || '').trim();
}

export function mimotoFleetWorkRuleId() {
  return String(process.env.MIMOTO_FLEET_WORK_RULE_ID || '').trim();
}

export function assertMimotoFleetWriteEnabled() {
  if (!MIMOTO_CONFIG.enabled || !MIMOTO_CONFIG.automationEnabled || !MIMOTO_CONFIG.fleetWithdrawEnabled) {
    throw new Error('El cobro Fleet real de Mi Moto está desactivado');
  }
}
