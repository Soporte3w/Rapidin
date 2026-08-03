ALTER TABLE module_miauto_fleet_charge_run
  ADD COLUMN IF NOT EXISTS source_run_id UUID REFERENCES module_miauto_fleet_charge_run(id),
  ADD COLUMN IF NOT EXISTS triggered_by UUID REFERENCES module_rapidin_users(id);

CREATE INDEX IF NOT EXISTS idx_miauto_fleet_charge_run_source
  ON module_miauto_fleet_charge_run (source_run_id, started_at DESC)
  WHERE source_run_id IS NOT NULL;
