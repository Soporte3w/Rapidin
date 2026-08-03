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
            weekly_fleet_retry_enabled, weekly_fleet_retry_interval_minutes,
            weekly_fleet_retry_max_attempts,
            daily_additional_expenses_enabled,
            daily_additional_expenses_time::text,
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
    weekly_fleet_retry_enabled: input?.weekly_fleet_retry_enabled ?? current.weekly_fleet_retry_enabled,
    weekly_fleet_retry_interval_minutes: input?.weekly_fleet_retry_interval_minutes
      ?? current.weekly_fleet_retry_interval_minutes,
    weekly_fleet_retry_max_attempts: input?.weekly_fleet_retry_max_attempts
      ?? current.weekly_fleet_retry_max_attempts,
    daily_additional_expenses_enabled: input?.daily_additional_expenses_enabled
      ?? current.daily_additional_expenses_enabled,
    daily_additional_expenses_time: input?.daily_additional_expenses_time
      ?? current.daily_additional_expenses_time,
  });

  const result = await query(
    `UPDATE module_miauto_automation_config
     SET weekly_generation_enabled = $1,
         weekly_generation_day = $2,
         weekly_generation_time = $3::time,
         weekly_fleet_charge_enabled = $4,
         weekly_fleet_charge_day = $5,
         weekly_fleet_charge_time = $6::time,
         weekly_fleet_retry_enabled = $7,
         weekly_fleet_retry_interval_minutes = $8,
         weekly_fleet_retry_max_attempts = $9,
         daily_additional_expenses_enabled = $10,
         daily_additional_expenses_time = $11::time,
         timezone = $12,
         updated_by = $13,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = 1
     RETURNING weekly_generation_enabled, weekly_generation_day,
               weekly_generation_time::text,
               weekly_fleet_charge_enabled, weekly_fleet_charge_day,
               weekly_fleet_charge_time::text,
               weekly_fleet_retry_enabled, weekly_fleet_retry_interval_minutes,
               weekly_fleet_retry_max_attempts,
               daily_additional_expenses_enabled,
               daily_additional_expenses_time::text,
               timezone, updated_at, updated_by`,
    [
      next.weekly_generation_enabled,
      next.weekly_generation_day,
      next.weekly_generation_time,
      next.weekly_fleet_charge_enabled,
      next.weekly_fleet_charge_day,
      next.weekly_fleet_charge_time,
      next.weekly_fleet_retry_enabled,
      next.weekly_fleet_retry_interval_minutes,
      next.weekly_fleet_retry_max_attempts,
      next.daily_additional_expenses_enabled,
      next.daily_additional_expenses_time,
      next.timezone,
      userId,
    ],
  );

  return apiRow(result.rows[0]);
}
