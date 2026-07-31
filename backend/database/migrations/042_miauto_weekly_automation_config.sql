CREATE TABLE IF NOT EXISTS module_miauto_automation_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  weekly_generation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  weekly_generation_day SMALLINT NOT NULL DEFAULT 1 CHECK (weekly_generation_day BETWEEN 1 AND 6),
  weekly_generation_time TIME NOT NULL DEFAULT '06:00',
  timezone TEXT NOT NULL DEFAULT 'America/Lima' CHECK (timezone = 'America/Lima'),
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO module_miauto_automation_config (
  id,
  weekly_generation_enabled,
  weekly_generation_day,
  weekly_generation_time,
  timezone
)
VALUES (1, TRUE, 1, '06:00', 'America/Lima')
ON CONFLICT (id) DO NOTHING;
