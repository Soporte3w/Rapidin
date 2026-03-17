-- Solo elimina las columnas redundantes validado y rechazado (usar si ya ejecutaste 022 sin los DROP)
ALTER TABLE module_miauto_comprobante_pago DROP COLUMN IF EXISTS validado;
ALTER TABLE module_miauto_comprobante_pago DROP COLUMN IF EXISTS rechazado;
