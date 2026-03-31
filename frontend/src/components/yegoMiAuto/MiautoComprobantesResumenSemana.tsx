import { monedaCuotasLabel, symMoneda } from '../../utils/miautoAlquilerVentaList';
import { roundToTwoDecimals } from '../../utils/currency';

/** Solo comprobantes del conductor: no sumar conformidad de pago ni registros admin (evita duplicar montos). */
function incluirEnResumenMonto(cp: { origen?: string | null }): boolean {
  const o = (cp.origen || 'conductor').toLowerCase();
  return o === 'conductor';
}

/** Símbolo para montos de comprobantes (moneda en que quedó registrado el monto, p. ej. PEN al validar). */
function symMontosComprobantesConductor(
  compsResumen: { moneda?: string | null; monto?: number | null }[],
  symCronogramaFallback: string
): string {
  const monedas = [...new Set(compsResumen.map((cp) => monedaCuotasLabel(cp.moneda)))];
  if (monedas.length === 1) return symMoneda(monedas[0]);
  if (monedas.length > 1) return symMoneda('PEN');
  return symCronogramaFallback;
}

/** Totales de comprobantes bajo la grilla de una semana (cuota semanal). */
export function MiautoComprobantesResumenSemana({
  comps,
  symCronograma,
  saldoPendienteSemanaCronograma,
}: {
  comps: { estado?: string | null; monto?: number | null; origen?: string | null; moneda?: string | null }[];
  /** Moneda de la fila del cronograma ($ / S/.) */
  symCronograma: string;
  /** Falta por cubrir en la semana según plan y columnas pagado/cuota (misma unidad que el cronograma). */
  saldoPendienteSemanaCronograma: number;
}) {
  const lower = (e: string | null | undefined) => (e || '').toLowerCase();
  const compsResumen = comps.filter(incluirEnResumenMonto);
  const totalEnv = compsResumen.reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const verificado = compsResumen.filter((cp) => lower(cp.estado) === 'validado').reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const rechazado = compsResumen.filter((cp) => lower(cp.estado) === 'rechazado').reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const symComp = symMontosComprobantesConductor(compsResumen, symCronograma);
  const saldoCronograma = roundToTwoDecimals(Math.max(0, Number(saldoPendienteSemanaCronograma) || 0));
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm text-gray-700 shadow-sm">
      <span title="Montos tal como figuran en los comprobantes (p. ej. soles si se validó en PEN).">
        <strong className="text-gray-800">Total enviado:</strong> {symComp} {totalEnv.toFixed(2)}
      </span>
      <span title="Montos tal como figuran en los comprobantes.">
        <strong className="text-gray-800">Verificado:</strong> {symComp} {verificado.toFixed(2)}
      </span>
      <span title="Montos tal como figuran en los comprobantes.">
        <strong className="text-gray-800">Rechazado:</strong> {symComp} {rechazado.toFixed(2)}
      </span>
      <span title="Saldo de esta semana según el cronograma (misma moneda que la fila de la tabla).">
        <strong className="text-gray-800">Saldo pendiente (plan):</strong> {symCronograma} {saldoCronograma.toFixed(2)}
      </span>
    </div>
  );
}
