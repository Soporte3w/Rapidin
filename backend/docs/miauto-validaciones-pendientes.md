# Mi Auto - validaciones pendientes

Fecha: 2026-07-06

## Pendiente critico

Antes de cerrar los cambios de cobros, validar funcionalmente la cascada Fleet con un caso real o simulado. El codigo ya recalcula mora antes de repartir el cobro, pero falta confirmar el flujo completo contra datos de prueba.

## Casos a validar

1. Cascada con cuota vencida y `late_fee = 0`: debe recalcular mora antes de cobrar.
2. Cascada con cuota marcada `paid`, pero pagada solo con capital: debe detectar saldo por mora y dejarla corregida.
3. Cascada con pago parcial: debe cobrar primero la mora pendiente y luego capital.
4. Cascada con `paid_amount > 0` y nuevo dia vencido: debe contemplar la mora extra segun la regla definida.
5. Cascada debe actualizar `fecha_ultimo_abono` cuando aumenta `paid_amount`.
6. Notas de venta deben permitir solo cuotas pagadas y sin nota ya generada.
7. Nota de venta debe tomar el total real pagado de la cuota, incluyendo cuota, mora y mora extra cuando corresponda.
8. Frontend no debe recalcular importes de cuota/mora para cobrar; debe mostrar lo que viene del backend.

## Datos de prueba creados

Solicitud Jhajaira:

- `a765c394-c659-4fcc-93cd-8bac802fb419`

Cuota 2 corregida manualmente:

- Cuota: `f20144dd-e1a6-45d1-908c-e290f4a5ae67`
- Fecha de pago: `2026-07-06`
- `amount_due`: `480.00`
- `late_fee`: `76.72`
- `paid_amount`: `556.72`
- `status`: `paid`

## Verificaciones tecnicas ya ejecutadas

- `node --check backend/yego_miauto/services/cobros/CobroEngine.js`
- `node --check backend/yego_miauto/services/cobros/CascadaPoolManager.js`
- `node --check backend/yego_miauto/services/facturacion/miautoNotaVentaService.js`
- `node --check backend/yego_miauto/routes/miauto/notasVenta.js`
- `npm run build` en frontend

## Nota

No se ejecuto aun una prueba funcional completa de cascada Fleet en produccion. Esa prueba queda pendiente antes de confirmar que el problema de los lunes quedo cerrado de punta a punta.
