ALTER TABLE module_miauto_automation_config
  ADD COLUMN IF NOT EXISTS weekly_fleet_charge_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS weekly_fleet_charge_day SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS weekly_fleet_charge_time TIME NOT NULL DEFAULT '07:10';

ALTER TABLE module_miauto_automation_config
  DROP CONSTRAINT IF EXISTS module_miauto_automation_config_weekly_fleet_charge_day_check;

ALTER TABLE module_miauto_automation_config
  ADD CONSTRAINT module_miauto_automation_config_weekly_fleet_charge_day_check
  CHECK (weekly_fleet_charge_day BETWEEN 1 AND 6);
