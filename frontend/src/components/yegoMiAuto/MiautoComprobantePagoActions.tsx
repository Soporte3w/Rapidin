import { useState } from 'react';
import toast from 'react-hot-toast';
import { symMoneda } from '../../utils/miautoAlquilerVentaList';
import { convertMontoPenUsd } from '../../utils/miautoPenUsdConversion';
import { roundToTwoDecimals } from '../../utils/currency';

type Moneda = 'PEN' | 'USD';

export function MiautoComprobantePagoActions({
  comprobanteId,
  validando,
  rechazando,
  onValidar,
  onRechazar,
  montoMaximo,
  defaultMoneda = 'PEN',
  /** 1 USD = N moneda local; si se indica, al cambiar S/./USD se recalcula el monto en el input. */
  valorUsdALocal,
}: {
  comprobanteId: string;
  validando: boolean;
  rechazando: boolean;
  onValidar: (id: string, monto: number, moneda: Moneda) => void;
  onRechazar: (id: string, motivo: string) => void;
  montoMaximo?: number;
  defaultMoneda?: Moneda;
  valorUsdALocal?: number;
}) {
  const [monto, setMonto] = useState('');
  const [moneda, setMoneda] = useState<Moneda>(defaultMoneda);
  const sym = symMoneda(moneda);
  const handleValidar = () => {
    const n = parseFloat(monto);
    if (Number.isNaN(n) || n <= 0) {
      toast.error('Indica un monto válido');
      return;
    }
    if (montoMaximo != null && montoMaximo > 0 && n > montoMaximo) {
      toast.error(`El monto no puede superar el total pendiente del cronograma (${sym} ${montoMaximo.toFixed(2)})`);
      return;
    }
    onValidar(comprobanteId, n, moneda);
  };
  const handleRechazar = () => {
    const motivo = window.prompt('Motivo del rechazo (opcional):');
    if (motivo === null) return;
    onRechazar(comprobanteId, motivo.trim());
  };
  const placeholder =
    montoMaximo != null && montoMaximo > 0 ? `Máx. cronograma ${sym} ${montoMaximo.toFixed(2)}` : 'Monto';
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input
        type="number"
        step="0.01"
        min="0"
        max={montoMaximo != null && montoMaximo > 0 ? montoMaximo : undefined}
        placeholder={placeholder}
        value={monto}
        onChange={(e) => setMonto(e.target.value)}
        className="w-20 px-1.5 py-0.5 border border-gray-300 rounded text-[11px]"
      />
      <select
        value={moneda}
        onChange={(e) => {
          const newMon = e.target.value as Moneda;
          const prevMon = moneda;
          if (prevMon === newMon) return;
          setMoneda(newMon);
          const tc = valorUsdALocal;
          if (tc == null || tc <= 0 || !monto.trim()) return;
          const num = parseFloat(monto);
          if (Number.isNaN(num) || num <= 0) return;
          const conv = convertMontoPenUsd(num, prevMon, newMon, tc);
          setMonto(roundToTwoDecimals(conv).toFixed(2));
        }}
        className="px-1.5 py-0.5 border border-gray-300 rounded text-[11px]"
      >
        <option value="PEN">S/.</option>
        <option value="USD">USD</option>
      </select>
      <button
        type="button"
        disabled={validando}
        onClick={handleValidar}
        className="px-1.5 py-0.5 bg-green-600 text-white rounded text-[10px] font-medium hover:bg-green-700 disabled:opacity-50"
      >
        {validando ? '...' : 'Validar'}
      </button>
      <button
        type="button"
        disabled={rechazando}
        onClick={handleRechazar}
        className="px-1.5 py-0.5 bg-red-600 text-white rounded text-[10px] font-medium hover:bg-red-700 disabled:opacity-50"
      >
        {rechazando ? '...' : 'Rechazar'}
      </button>
    </span>
  );
}
