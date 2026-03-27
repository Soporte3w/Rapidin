/** Solo comprobantes del conductor: no sumar conformidad de pago ni registros admin (evita duplicar montos). */
function incluirEnResumenMonto(cp: { origen?: string | null }): boolean {
  const o = (cp.origen || 'conductor').toLowerCase();
  return o === 'conductor';
}

/** Totales de comprobantes bajo la grilla de una semana (cuota semanal). */
export function MiautoComprobantesResumenSemana({
  sym,
  comps,
  amountDue,
  lateFee,
  totalCuotaSemana,
}: {
  sym: string;
  comps: { estado?: string | null; monto?: number | null; origen?: string | null }[];
  amountDue: number;
  lateFee: number;
  /** Si viene (cuota final = neto + mora), alinea "pendiente" con la grilla; si no, amountDue + lateFee */
  totalCuotaSemana?: number;
}) {
  const lower = (e: string | null | undefined) => (e || '').toLowerCase();
  const compsResumen = comps.filter(incluirEnResumenMonto);
  const totalEnv = compsResumen.reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const verificado = compsResumen.filter((cp) => lower(cp.estado) === 'validado').reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const rechazado = compsResumen.filter((cp) => lower(cp.estado) === 'rechazado').reduce((s, cp) => s + (Number(cp.monto) || 0), 0);
  const topeSemana =
    totalCuotaSemana != null && !Number.isNaN(Number(totalCuotaSemana)) ? Number(totalCuotaSemana) : amountDue + lateFee;
  const restantePorPagar = Math.max(0, topeSemana - verificado);
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-white border border-gray-200 px-4 py-3 text-sm text-gray-700 shadow-sm">
      <span>
        <strong className="text-gray-800">Total enviado:</strong> {sym} {totalEnv.toFixed(2)}
      </span>
      <span>
        <strong className="text-gray-800">Verificado:</strong> {sym} {verificado.toFixed(2)}
      </span>
      <span>
        <strong className="text-gray-800">Rechazado:</strong> {sym} {rechazado.toFixed(2)}
      </span>
      <span>
        <strong className="text-gray-800">Pendiente por validar:</strong> {sym} {restantePorPagar.toFixed(2)}
      </span>
    </div>
  );
}
