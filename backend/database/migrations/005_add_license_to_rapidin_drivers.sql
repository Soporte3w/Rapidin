-- Columna licencia en module_rapidin_drivers (ej. "Q41221733", "F07658692")
ALTER TABLE module_rapidin_drivers ADD COLUMN IF NOT EXISTS license VARCHAR(100);
