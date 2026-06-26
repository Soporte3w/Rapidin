-- Agrega permisos por módulo a los usuarios del sistema
ALTER TABLE module_rapidin_users ADD COLUMN IF NOT EXISTS allowed_modules TEXT[] NOT NULL DEFAULT '{rapidin}';
