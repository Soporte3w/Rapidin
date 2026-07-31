import { query } from '../../../config/database.js';
import {
  normalizeMiautoAutomationConfig,
  validateMiautoAutomationConfig,
} from './miautoAutomationConfig.js';

function apiRow(row) {
  return {
    ...normalizeMiautoAutomationConfig(row),
    updated_at: row?.updated_at || null,
    updated_by: row?.updated_by || null,
  };
}

export async function getMiautoAutomationConfig() {
  const result = await query(
    `SELECT weekly_generation_enabled, weekly_generation_day,
            weekly_generation_time::text,
            weekly_fleet_charge_enabled, weekly_fleet_charge_day,
            weekly_fleet_charge_time::text,
            timezone, updated_at, updated_by
     FROM module_miauto_automation_config
     WHERE id = 1`,
  );
  return apiRow(result.rows[0]);
}

export async function updateMiautoAutomationConfig(input, userId = null) {
  const current = await getMiautoAutomationConfig();
  const next = validateMiautoAutomationConfig({
    weekly_generation_enabled: input?.weekly_generation_enabled ?? current.weekly_generation_enabled,
    weekly_generation_day: input?.weekly_generation_day ?? current.weekly_generation_day,
    weekly_generation_time: input?.weekly_generation_time ?? current.weekly_generation_time,
    weekly_fleet_charge_enabled: input?.weekly_fleet_charge_enabled ?? current.weekly_fleet_charge_enabled,
    weekly_fleet_charge_day: input?.weekly_fleet_charge_day ?? current.weekly_fleet_charge_day,
    weekly_fleet_charge_time: input?.weekly_fleet_charge_time ?? current.weekly_fleet_charge_time,
  });

  const result = await query(
    `UPDATE module_miauto_automation_config
     SET weekly_generation_enabled = $1,
         weekly_generation_day = $2,
         weekly_generation_time = $3::time,
         weekly_fleet_charge_enabled = $4,
         weekly_fleet_charge_day = $5,
         weekly_fleet_charge_time = $6::time,
         timezone = $7,
         updated_by = $8,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1
     RETURNING weekly_generation_enabled, weekly_generation_day,
               weekly_generation_time::text,
               weekly_fleet_charge_enabled, weekly_fleet_charge_day,
               weekly_fleet_charge_time::text,
               timezone, updated_at, updated_by`,
    [
      next.weekly_generation_enabled,
      next.weekly_generation_day,
      next.weekly_generation_time,
      next.weekly_fleet_charge_enabled,
      next.weekly_fleet_charge_day,
      next.weekly_fleet_charge_time,
      next.timezone,
      userId,
    ],
  );

  return apiRow(result.rows[0]);
}
