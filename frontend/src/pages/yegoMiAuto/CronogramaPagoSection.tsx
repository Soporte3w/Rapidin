import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Car, ChevronDown, ChevronRight, ChevronLeft, Calendar, CheckCircle, File, FileText, X, PlusCircle, Wallet } from 'lucide-react';

export type PasoCP = 1 | 2 | 3;
export type PagoTipo = 'completo' | 'parcial';

export interface CronogramaPagoSectionProps {
  solicitud: any;
  cronogramasList: any[];
  loadingCronogramas: boolean;
  tipoCambio: { moneda_local: string; valor_usd_a_local: number } | null;
  selectedCronogramaForVehicles: any;
  setSelectedCronogramaForVehicles: (c: any) => void;
  selectedVehiculoId: string | number | null;
  setSelectedVehiculoId: (id: string | number | null) => void;
  pendingPagoTipo: PagoTipo;
  setPendingPagoTipo: (t: PagoTipo) => void;
  pasoCronogramaPago: PasoCP;
  setPasoCronogramaPago: (p: PasoCP | ((prev: PasoCP) => PasoCP)) => void;
  pagoSectionOpen: boolean;
  setPagoSectionOpen: (open: boolean) => void;
  actionLoading: boolean;
  onGuardarCronogramaPago: () => Promise<void>;
  onValidarComprobante?: (comprobanteId: string, data: { monto: number; moneda: 'PEN' | 'USD' }) => Promise<void>;
  onRechazarComprobante?: (comprobanteId: string, data: { motivo: string }) => Promise<void>;
  validandoComprobanteId?: string | null;
  rechazandoComprobanteId?: string | null;
  onAgregarComprobante?: (file: File, monto: number, moneda: 'PEN' | 'USD') => Promise<void>;
  onAgregarPagoManual?: (monto: number, moneda: 'PEN' | 'USD') => Promise<void>;
  getAdjuntoUrl: (filePath: string | undefined) => string;
}

export function CronogramaPagoSection({
  solicitud,
  cronogramasList,
  loadingCronogramas,
  tipoCambio,
  selectedCronogramaForVehicles,
  setSelectedCronogramaForVehicles,
  selectedVehiculoId,
  setSelectedVehiculoId,
  pendingPagoTipo,
  setPendingPagoTipo,
  pasoCronogramaPago,
  setPasoCronogramaPago,
  pagoSectionOpen,
  setPagoSectionOpen,
  actionLoading,
  onGuardarCronogramaPago,
  onValidarComprobante,
  onRechazarComprobante,
  validandoComprobanteId,
  rechazandoComprobanteId,
  onAgregarComprobante,
  onAgregarPagoManual,
  getAdjuntoUrl,
}: CronogramaPagoSectionProps) {
  const sinAsignacion = !solicitud.cronograma_id;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setPagoSectionOpen(!pagoSectionOpen)}
        className="w-full px-3 py-2.5 sm:px-4 sm:py-3 border-b border-gray-200 flex items-center justify-between text-left hover:bg-gray-50/50 transition-colors duration-200"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-8 h-8 sm:w-9 sm:h-9 shrink-0 rounded-lg bg-[#8B1A1A]/10 flex items-center justify-center">
            <Car className="w-4 h-4 sm:w-5 sm:h-5 text-[#8B1A1A]" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm sm:text-base font-semibold text-gray-900 truncate">Cronograma y pago</h2>
            <p className="text-xs text-gray-500 truncate">Asigna cronograma, carro y tipo de pago</p>
          </div>
        </div>
        <span className="shrink-0">{pagoSectionOpen ? <ChevronDown className="w-5 h-5 text-gray-500" /> : <ChevronRight className="w-5 h-5 text-gray-500" />}</span>
      </button>
      {pagoSectionOpen && (
        <div className="p-3 sm:p-4 animate-fade-in">
          {sinAsignacion ? (
            <WizardSinAsignacion
              cronogramasList={cronogramasList}
              loadingCronogramas={loadingCronogramas}
              tipoCambio={tipoCambio}
              selectedCronogramaForVehicles={selectedCronogramaForVehicles}
              setSelectedCronogramaForVehicles={setSelectedCronogramaForVehicles}
              selectedVehiculoId={selectedVehiculoId}
              setSelectedVehiculoId={setSelectedVehiculoId}
              pendingPagoTipo={pendingPagoTipo}
              setPendingPagoTipo={setPendingPagoTipo}
              pasoCronogramaPago={pasoCronogramaPago}
              setPasoCronogramaPago={setPasoCronogramaPago}
              actionLoading={actionLoading}
              onGuardarCronogramaPago={onGuardarCronogramaPago}
              getAdjuntoUrl={getAdjuntoUrl}
            />
          ) : (
            <AsignacionActual
              solicitud={solicitud}
              cronogramasList={cronogramasList}
              tipoCambio={tipoCambio}
              actionLoading={actionLoading}
              onValidarComprobante={onValidarComprobante}
              onRechazarComprobante={onRechazarComprobante}
              validandoComprobanteId={validandoComprobanteId}
              rechazandoComprobanteId={rechazandoComprobanteId}
              onAgregarComprobante={onAgregarComprobante}
              onAgregarPagoManual={onAgregarPagoManual}
              getAdjuntoUrl={getAdjuntoUrl}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StepperCP({ paso }: { paso: PasoCP }) {
  return (
    <div className="flex items-center gap-0 mb-4">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${paso >= 1 ? (paso === 1 ? 'bg-[#8B1A1A] text-white' : 'bg-green-500 text-white') : 'bg-gray-200 text-gray-500'}`}>
          {paso > 1 ? <CheckCircle className="w-4 h-4" /> : <Calendar className="w-4 h-4" />}
        </span>
        <span className={`text-xs font-semibold hidden sm:inline ${paso === 1 ? 'text-[#8B1A1A]' : paso > 1 ? 'text-green-600' : 'text-gray-500'}`}>Cronograma</span>
      </div>
      <div className={`flex-1 h-0.5 min-w-[12px] transition-colors duration-200 ${paso > 1 ? 'bg-green-200' : 'bg-gray-200'}`} />
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${paso >= 2 ? (paso === 2 ? 'bg-[#8B1A1A] text-white' : 'bg-green-500 text-white') : 'bg-gray-200 text-gray-500'}`}>
          {paso > 2 ? <CheckCircle className="w-4 h-4" /> : <Car className="w-4 h-4" />}
        </span>
        <span className={`text-xs font-semibold hidden sm:inline ${paso === 2 ? 'text-[#8B1A1A]' : paso > 2 ? 'text-green-600' : 'text-gray-500'}`}>Carro</span>
      </div>
      <div className={`flex-1 h-0.5 min-w-[12px] transition-colors duration-200 ${paso > 2 ? 'bg-green-200' : 'bg-gray-200'}`} />
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${paso === 3 ? 'bg-[#8B1A1A] text-white' : 'bg-gray-200 text-gray-500'}`}>
          <Wallet className="w-4 h-4" />
        </span>
        <span className={`text-xs font-semibold hidden sm:inline ${paso === 3 ? 'text-[#8B1A1A]' : 'text-gray-500'}`}>Pago</span>
      </div>
    </div>
  );
}

function WizardSinAsignacion({
  cronogramasList,
  loadingCronogramas,
  tipoCambio,
  selectedCronogramaForVehicles,
  setSelectedCronogramaForVehicles,
  selectedVehiculoId,
  setSelectedVehiculoId,
  pendingPagoTipo,
  setPendingPagoTipo,
  pasoCronogramaPago,
  setPasoCronogramaPago,
  actionLoading,
  onGuardarCronogramaPago,
  getAdjuntoUrl,
}: {
  cronogramasList: any[];
  loadingCronogramas: boolean;
  tipoCambio: { moneda_local: string; valor_usd_a_local: number } | null;
  selectedCronogramaForVehicles: any;
  setSelectedCronogramaForVehicles: (c: any) => void;
  selectedVehiculoId: string | number | null;
  setSelectedVehiculoId: (id: string | number | null) => void;
  pendingPagoTipo: PagoTipo;
  setPendingPagoTipo: (t: PagoTipo) => void;
  pasoCronogramaPago: PasoCP;
  setPasoCronogramaPago: (p: PasoCP | ((prev: PasoCP) => PasoCP)) => void;
  actionLoading: boolean;
  onGuardarCronogramaPago: () => Promise<void>;
  getAdjuntoUrl: (filePath: string | undefined) => string;
}) {
  if (loadingCronogramas) {
    return (
      <div className="flex justify-center py-6">
        <div className="animate-spin rounded-full h-7 w-7 border-2 border-[#8B1A1A] border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      <StepperCP paso={pasoCronogramaPago} />

      {pasoCronogramaPago === 1 && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {cronogramasList.map((c: any) => {
              const isSelected = selectedCronogramaForVehicles?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCronogramaForVehicles(c)}
                  className={`flex items-start gap-3 p-3 sm:p-4 rounded-xl border text-left transition-all duration-200 shadow-sm hover:shadow min-w-0 ${isSelected ? 'border-[#8B1A1A] bg-red-50/30' : 'border-gray-200 bg-white hover:border-[#8B1A1A] hover:bg-red-50/20'}`}
                >
                  {isSelected && <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#8B1A1A] text-white mt-0.5"><CheckCircle className="w-3 h-3" /></span>}
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[9px] sm:text-[10px] font-bold text-gray-900 leading-snug break-words">{c.name || 'Sin nombre'}</h3>
                    <p className="text-[10px] text-gray-500 mt-0.5">{c.vehicles?.length ?? 0} carro(s) disponibles</p>
                  </div>
                </button>
              );
            })}
            {cronogramasList.length === 0 && <p className="text-xs text-gray-500 col-span-full py-4">No hay cronogramas activos. Crea uno en Configuración.</p>}
          </div>
        </div>
      )}

      {pasoCronogramaPago === 2 && selectedCronogramaForVehicles && (
        <div className="space-y-4">
          <div className="flex items-center gap-1.5 text-sm text-gray-600">
            <span className="font-semibold truncate">{selectedCronogramaForVehicles.name || 'Cronograma'}</span>
          </div>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {(selectedCronogramaForVehicles.vehicles || []).map((v: any) => {
              const equivUsd = v.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local ? Number(v.inicial) * tipoCambio.valor_usd_a_local : null;
              const equivSym = tipoCambio?.moneda_local === 'COP' ? 'COP' : 'S/.';
              const isSelected = selectedVehiculoId === v.id;
              const imgSrc = v.image && (v.image.startsWith('data:') || v.image.startsWith('http')) ? v.image : v.image ? getAdjuntoUrl(v.image) : null;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setSelectedVehiculoId(v.id)}
                  className={`relative rounded-xl border bg-white text-left transition-all duration-200 overflow-hidden shadow-sm hover:shadow flex flex-col min-w-0 ${isSelected ? 'border-[#8B1A1A] bg-red-50/30 ring-2 ring-[#8B1A1A]/20' : 'border-gray-200 hover:border-gray-300'}`}
                >
                  {isSelected && (
                    <span className="absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-[#8B1A1A] text-white shadow">
                      <CheckCircle className="w-3.5 h-3.5" />
                    </span>
                  )}
                  {imgSrc && (
                    <div className="aspect-[4/3] bg-gray-100 overflow-hidden">
                      <img src={imgSrc} alt={v.name || 'Carro'} className="w-full h-full object-cover" />
                    </div>
                  )}
                  <div className="p-4 flex-1 min-w-0 flex flex-col gap-1">
                    <h3 className="text-sm font-bold text-gray-900 leading-tight truncate">{v.name || 'Sin nombre'}</h3>
                    <p className="text-sm text-gray-700"><span className="font-semibold">{v.inicial_moneda === 'PEN' ? 'S/.' : '$'} {Number(v.inicial).toFixed(2)}</span> inicial</p>
                    <p className="text-xs text-gray-500">{v.cuotas_semanales} cuotas/sem{equivUsd != null ? ` · Equiv. ${equivSym} ${equivUsd.toFixed(2)}` : ''}</p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {pasoCronogramaPago === 3 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className={`cursor-pointer rounded-lg border p-2.5 sm:p-3 transition-all duration-200 flex items-center gap-2 bg-white min-w-0 ${pendingPagoTipo === 'completo' ? 'border-[#8B1A1A] bg-red-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
              <span className={`flex h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ${pendingPagoTipo === 'completo' ? 'border-[#8B1A1A] bg-[#8B1A1A]' : 'border-gray-400'}`}>
                {pendingPagoTipo === 'completo' && <span className="h-1 w-1 rounded-full bg-white" />}
              </span>
              <span className={`text-xs sm:text-sm font-medium truncate ${pendingPagoTipo === 'completo' ? 'text-[#8B1A1A]' : 'text-gray-700'}`}>Pago completo</span>
              <input type="radio" name="pending_pago_tipo" checked={pendingPagoTipo === 'completo'} onChange={() => setPendingPagoTipo('completo')} className="sr-only" />
            </label>
            <label className={`cursor-pointer rounded-lg border p-2.5 sm:p-3 transition-all duration-200 flex items-center gap-2 bg-white min-w-0 ${pendingPagoTipo === 'parcial' ? 'border-[#8B1A1A] bg-red-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
              <span className={`flex h-3.5 w-3.5 shrink-0 rounded-full border flex items-center justify-center ${pendingPagoTipo === 'parcial' ? 'border-[#8B1A1A] bg-[#8B1A1A]' : 'border-gray-400'}`}>
                {pendingPagoTipo === 'parcial' && <span className="h-1 w-1 rounded-full bg-white" />}
              </span>
              <span className={`text-xs sm:text-sm font-medium truncate ${pendingPagoTipo === 'parcial' ? 'text-[#8B1A1A]' : 'text-gray-700'}`}>Pago parcial</span>
              <input type="radio" name="pending_pago_tipo" checked={pendingPagoTipo === 'parcial'} onChange={() => setPendingPagoTipo('parcial')} className="sr-only" />
            </label>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-4 mt-4 border-t border-gray-200">
        <div>
          {pasoCronogramaPago > 1 ? (
            <button type="button" onClick={() => setPasoCronogramaPago((p) => (p - 1) as PasoCP)} className="inline-flex items-center gap-1.5 text-gray-600 hover:text-gray-900 text-sm font-medium transition-colors">
              <ChevronLeft className="w-4 h-4" /> Atrás
            </button>
          ) : (
            <span />
          )}
        </div>
        <div className="flex items-center gap-2">
          {pasoCronogramaPago < 3 ? (
            <button
              type="button"
              onClick={() => setPasoCronogramaPago((p) => (p + 1) as PasoCP)}
              disabled={(pasoCronogramaPago === 1 && !selectedCronogramaForVehicles) || (pasoCronogramaPago === 2 && !selectedVehiculoId)}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Siguiente <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" onClick={onGuardarCronogramaPago} disabled={actionLoading || !selectedVehiculoId} className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              Guardar
            </button>
          )}
        </div>
      </div>
      {pasoCronogramaPago === 3 && !selectedVehiculoId && <p className="text-xs text-red-600 mt-1">Elige un carro en el paso anterior para poder guardar.</p>}
    </>
  );
}

function AsignacionActual({
  solicitud,
  cronogramasList = [],
  tipoCambio,
  actionLoading,
  onValidarComprobante,
  onRechazarComprobante,
  validandoComprobanteId,
  rechazandoComprobanteId,
  onAgregarComprobante,
  onAgregarPagoManual,
  getAdjuntoUrl,
}: {
  solicitud: any;
  cronogramasList?: any[];
  tipoCambio: { moneda_local: string; valor_usd_a_local: number } | null;
  actionLoading: boolean;
  onValidarComprobante?: (comprobanteId: string, data: { monto: number; moneda: 'PEN' | 'USD' }) => Promise<void>;
  onRechazarComprobante?: (comprobanteId: string, data: { motivo: string }) => Promise<void>;
  validandoComprobanteId?: string | null;
  rechazandoComprobanteId?: string | null;
  onAgregarComprobante?: (file: File, monto: number, moneda: 'PEN' | 'USD') => Promise<void>;
  onAgregarPagoManual?: (monto: number, moneda: 'PEN' | 'USD') => Promise<void>;
  getAdjuntoUrl: (filePath: string | undefined) => string;
}) {
  const [comprobanteAValidar, setComprobanteAValidar] = useState<{ id: string; file_name?: string; monto?: number } | null>(null);
  const [comprobanteARechazar, setComprobanteARechazar] = useState<{ id: string; file_name?: string } | null>(null);
  const [modalMonto, setModalMonto] = useState('');
  const [modalMoneda, setModalMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [modalRechazoMotivo, setModalRechazoMotivo] = useState('');
  const [comprobantePreview, setComprobantePreview] = useState<{ url: string; fileName: string; isImage: boolean } | null>(null);
  const [modalAgregarPago, setModalAgregarPago] = useState(false);
  const [agregarPagoTipo, setAgregarPagoTipo] = useState<'comprobante' | 'manual'>('comprobante');
  const [agregarFile, setAgregarFile] = useState<File | null>(null);
  const [agregarMonto, setAgregarMonto] = useState('');
  const [agregarMoneda, setAgregarMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [agregandoPago, setAgregandoPago] = useState(false);

  // Resolver cronograma y vehículo desde API o desde lista (fallback cuando API devuelve cronograma_vehiculo: null)
  const cronogramaDisplay = solicitud.cronograma?.name != null
    ? solicitud.cronograma
    : (solicitud.cronograma_id && Array.isArray(cronogramasList)
        ? cronogramasList.find((c: any) => c.id === solicitud.cronograma_id) || null
        : null);
  const vehiculoFromApi = solicitud.cronograma_vehiculo && (solicitud.cronograma_vehiculo.name != null || solicitud.cronograma_vehiculo.inicial != null);
  const vehiculoFromListById =
    !vehiculoFromApi && solicitud.cronograma_vehiculo_id && Array.isArray(cronogramasList)
      ? (() => {
          const c = cronogramasList.find((cr: any) => String(cr.id) === String(solicitud.cronograma_id));
          const v = c?.vehicles?.find((ve: any) => String(ve.id) === String(solicitud.cronograma_vehiculo_id));
          return v ? { id: v.id, name: v.name, inicial: v.inicial, inicial_moneda: v.inicial_moneda || 'USD', image: v.image } : null;
        })()
      : null;
  const vehiculoFromListFirst =
    !vehiculoFromApi && !vehiculoFromListById && cronogramaDisplay?.vehicles?.length
      ? (() => {
          const v = cronogramaDisplay.vehicles[0];
          return { id: v.id, name: v.name, inicial: v.inicial, inicial_moneda: v.inicial_moneda || 'USD', image: v.image };
        })()
      : null;
  const vehiculoDisplay = vehiculoFromApi ? solicitud.cronograma_vehiculo : (vehiculoFromListById || vehiculoFromListFirst);

  type EstadoComprobante = 'pendiente' | 'validado' | 'rechazado';
  const getEstado = (cp: any): EstadoComprobante => {
    const e = (cp.estado || '').toLowerCase();
    if (e === 'validado' || e === 'rechazado') return e;
    return cp.rechazado ? 'rechazado' : cp.validado ? 'validado' : 'pendiente';
  };

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const comprobantes = Array.isArray(solicitud.comprobantes_pago) ? solicitud.comprobantes_pago : [];
  const totalValidado =
    solicitud.total_validado != null
      ? round2(Number(solicitud.total_validado))
      : round2(
          comprobantes
            .filter((cp: any) => getEstado(cp) === 'validado' && cp.monto != null)
            .reduce((sum: number, cp: any) => sum + Number(cp.monto), 0)
        );
  const cuotaInicial = round2(vehiculoDisplay?.inicial != null ? Number(vehiculoDisplay.inicial) : 0);
  const moneda = vehiculoDisplay?.inicial_moneda === 'PEN' ? 'S/.' : '$';
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 sm:p-4 space-y-3">
        <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Asignación actual</p>
        <div className="flex flex-col sm:flex-row gap-3">
          {vehiculoDisplay?.image && (
            <div className="flex-shrink-0 w-full sm:w-28 h-20 rounded-lg overflow-hidden bg-gray-200">
              <img src={vehiculoDisplay.image.startsWith('data:') || vehiculoDisplay.image.startsWith('http') ? vehiculoDisplay.image : getAdjuntoUrl(vehiculoDisplay.image)} alt={vehiculoDisplay?.name || 'Carro'} className="w-full h-full object-cover" />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-1 gap-x-3 gap-y-0.5 text-xs min-w-0">
            <div><dt className="text-gray-500 text-[11px]">Cronograma</dt><dd className="font-medium text-gray-900 truncate">{cronogramaDisplay?.name || '—'}</dd></div>
            <div><dt className="text-gray-500 text-[11px]">Carro</dt><dd className="font-medium text-gray-900 truncate">{vehiculoDisplay?.name || '—'}</dd></div>
            <div>
              <dt className="text-gray-500 text-[11px]">Cuota inicial</dt>
              <dd className="font-medium text-gray-900">
                {vehiculoDisplay ? `${vehiculoDisplay.inicial_moneda === 'PEN' ? 'S/.' : '$'} ${Number(vehiculoDisplay.inicial).toFixed(2)}` : '—'}
                {vehiculoDisplay?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
                  <span className="block text-[11px] font-normal text-gray-500">
                    Equiv. {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(Number(vehiculoDisplay.inicial) * tipoCambio.valor_usd_a_local).toFixed(2)}
                  </span>
                )}
              </dd>
            </div>
            <div><dt className="text-gray-500 text-[11px]">Tipo de pago</dt><dd className="font-medium text-gray-900">{solicitud.pago_tipo === 'parcial' ? 'Pago parcial' : 'Pago completo'}</dd></div>
            <div>
              <dt className="text-gray-500 text-[11px]">Estado de pago</dt>
              <dd className="font-medium">
                {solicitud.pago_estado === 'completo' ? (
                  <span className="text-green-700">Completado</span>
                ) : (
                  <span className="text-amber-700">Pendiente</span>
                )}
              </dd>
            </div>
          </div>
        </div>
      </div>
      <div className="rounded-lg bg-gray-50 border border-gray-200 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Comprobantes subidos por el conductor</p>
          {(onAgregarComprobante || onAgregarPagoManual) && solicitud.pago_estado !== 'completo' && !solicitud.fecha_inicio_cobro_semanal && (
            <button
              type="button"
              onClick={() => {
                setModalAgregarPago(true);
                setAgregarPagoTipo('comprobante');
                setAgregarFile(null);
                setAgregarMonto('');
                setAgregarMoneda('PEN');
              }}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#8B1A1A] bg-white border border-[#8B1A1A]/30 rounded-lg hover:bg-[#8B1A1A]/5 disabled:opacity-50"
            >
              <PlusCircle className="w-4 h-4" /> Agregar pago
            </button>
          )}
        </div>
        {comprobantes.length > 0 && cuotaInicial > 0 && (
          <div className="mb-2">
            <p className="text-xs text-gray-600">
              Cuota inicial: <span className="font-medium">{moneda} {cuotaInicial.toFixed(2)}</span>
              {' · '}
              Validado: <span className="font-medium text-green-700">{moneda} {totalValidado.toFixed(2)}</span>
              {totalValidado >= cuotaInicial && <span className="ml-1 text-green-600 font-medium">(completo)</span>}
            </p>
            {solicitud.cronograma_vehiculo?.inicial_moneda === 'USD' && tipoCambio?.valor_usd_a_local && (
              <p className="text-[11px] text-gray-400 mt-0.5">
                {tipoCambio.moneda_local === 'COP' ? 'Pesos (CO):' : 'Soles (PE):'}{' '}
                {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(totalValidado * tipoCambio.valor_usd_a_local).toFixed(2)} / {tipoCambio.moneda_local === 'COP' ? 'COP' : 'S/.'} {(cuotaInicial * tipoCambio.valor_usd_a_local).toFixed(2)}
              </p>
            )}
          </div>
        )}
        {comprobantes.length > 0 ? (
          <div className="flex flex-wrap gap-2 justify-start">
            {comprobantes.map((cp: any, index: number) => {
              const isPagoManual = cp.file_path === 'manual';
              const url = getAdjuntoUrl(cp.file_path);
              const isImage = !isPagoManual && /\.(jpe?g|png|gif|webp)$/i.test(cp.file_name || '');
              const validando = validandoComprobanteId === cp.id;
              const estado = getEstado(cp);
              return (
                <div key={cp.id} className="flex flex-col items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => !isPagoManual && setComprobantePreview({ url, fileName: cp.file_name || 'Comprobante', isImage })}
                    className="relative rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden hover:border-[#8B1A1A]/40 hover:shadow transition-all w-[100px] h-[100px] sm:w-[110px] sm:h-[110px] flex items-center justify-center p-0 cursor-pointer"
                  >
                    <span className="absolute top-1 left-1 z-10 w-6 h-6 rounded-full bg-[#8B1A1A] text-white text-xs font-bold flex items-center justify-center">
                      {index + 1}
                    </span>
                    {estado === 'validado' && (
                      <span className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-green-600 text-white flex items-center justify-center" title="Validado">
                        <CheckCircle className="w-3 h-3" />
                      </span>
                    )}
                    {estado === 'rechazado' && (
                      <span className="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded bg-red-600 text-white text-[10px] font-medium" title={cp.rechazo_razon || 'Rechazado'}>
                        Rechazado
                      </span>
                    )}
                    {isPagoManual ? (
                      <div className="w-full h-full flex flex-col items-center justify-center bg-gray-50 p-1">
                        <Wallet className="w-6 h-6 text-gray-500" />
                        <span className="text-[9px] text-gray-500 font-medium text-center leading-tight">Pago manual</span>
                        {cp.monto != null && (
                          <span className="text-[10px] font-semibold text-gray-700 mt-0.5">{moneda} {Number(cp.monto).toFixed(2)}</span>
                        )}
                      </div>
                    ) : isImage ? (
                      <img src={url} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gray-50">
                        <FileText className="w-8 h-8 text-gray-400" />
                      </div>
                    )}
                  </button>
                  {estado === 'pendiente' && (
                    <div className="flex gap-2">
                      {onValidarComprobante && (
                        <button
                          type="button"
                          onClick={() => {
                            setComprobanteAValidar({ id: cp.id, file_name: cp.file_name, monto: cp.monto != null ? Number(cp.monto) : undefined });
                            setModalMonto(cp.monto != null ? String(cp.monto) : '');
                            setModalMoneda('PEN');
                          }}
                          disabled={actionLoading || validando}
                          className="text-xs font-medium text-[#8B1A1A] hover:underline disabled:opacity-50"
                        >
                          {validando ? 'Validando…' : 'Validar'}
                        </button>
                      )}
                      {onRechazarComprobante && (
                        <button
                          type="button"
                          onClick={() => {
                            setComprobanteARechazar({ id: cp.id, file_name: cp.file_name });
                            setModalRechazoMotivo('');
                          }}
                          disabled={actionLoading || rechazandoComprobanteId === cp.id}
                          className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                        >
                          {rechazandoComprobanteId === cp.id ? 'Rechazando…' : 'Rechazar'}
                        </button>
                      )}
                    </div>
                  )}
                  {estado === 'rechazado' && cp.rechazo_razon && (
                    <p className="text-[10px] text-red-600 max-w-[110px] truncate" title={cp.rechazo_razon}>{cp.rechazo_razon}</p>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg bg-white/60 border border-dashed border-gray-200 py-6 text-center">
            <File className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">Aún no hay comprobantes.</p>
          </div>
        )}
      </div>

      {comprobanteAValidar && onValidarComprobante && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
          style={{ zIndex: 9999 }}
          onClick={() => setComprobanteAValidar(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Validar comprobante"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Validar comprobante</h3>
            <p className="text-sm text-gray-600 mb-4 truncate">{comprobanteAValidar.file_name || 'Comprobante'}</p>
            {cuotaInicial > 0 && (
              <p className="text-xs text-gray-500 mb-3">
                Cuota inicial: <span className="font-medium">{moneda} {cuotaInicial.toFixed(2)}</span>
                {' · '}
                Validado: <span className="font-medium text-green-700">{moneda} {totalValidado.toFixed(2)}</span>
              </p>
            )}
            <p className="text-xs text-gray-500 mb-3">Indica el monto que depositó el conductor y la moneda. Se convertirá a la moneda de la cuota inicial ({moneda}).</p>
            <div className="space-y-3 mb-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Monto depositado</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={modalMonto}
                  onChange={(e) => setModalMonto(e.target.value)}
                  placeholder="Ej. 500"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Moneda del depósito</label>
                <select
                  value={modalMoneda}
                  onChange={(e) => setModalMoneda(e.target.value as 'PEN' | 'USD')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A]"
                >
                  <option value="PEN">Soles (PEN)</option>
                  <option value="USD">Dólares (USD)</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setComprobanteAValidar(null)} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  const num = parseFloat(modalMonto.replace(',', '.'));
                  if (Number.isNaN(num) || num <= 0) return;
                  await onValidarComprobante(comprobanteAValidar.id, { monto: num, moneda: modalMoneda });
                  setComprobanteAValidar(null);
                }}
                disabled={actionLoading || validandoComprobanteId === comprobanteAValidar.id}
                className="flex-1 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 font-medium"
              >
                {validandoComprobanteId === comprobanteAValidar.id ? 'Validando…' : 'Validar'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {comprobanteARechazar && onRechazarComprobante && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
          style={{ zIndex: 9999 }}
          onClick={() => setComprobanteARechazar(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Rechazar comprobante"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Rechazar comprobante</h3>
            <p className="text-sm text-gray-600 mb-4 truncate">{comprobanteARechazar.file_name || 'Comprobante'}</p>
            <p className="text-xs text-gray-500 mb-2">Indica el motivo del rechazo (ej. foto no legible). El conductor podrá ver este mensaje.</p>
            <div className="mb-5">
              <label className="block text-sm font-medium text-gray-700 mb-1">Motivo del rechazo</label>
              <textarea
                value={modalRechazoMotivo}
                onChange={(e) => setModalRechazoMotivo(e.target.value)}
                placeholder="Ej. Foto no legible, vuelve a subir el comprobante"
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => setComprobanteARechazar(null)} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  const motivo = modalRechazoMotivo.trim();
                  if (!motivo) return;
                  await onRechazarComprobante(comprobanteARechazar.id, { motivo });
                  setComprobanteARechazar(null);
                  setModalRechazoMotivo('');
                }}
                disabled={actionLoading || rechazandoComprobanteId === comprobanteARechazar.id || !modalRechazoMotivo.trim()}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium"
              >
                {rechazandoComprobanteId === comprobanteARechazar.id ? 'Rechazando…' : 'Rechazar'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {modalAgregarPago && (onAgregarComprobante || onAgregarPagoManual) && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
          style={{ zIndex: 9999 }}
          onClick={() => {
            if (!agregandoPago) setModalAgregarPago(false);
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Agregar pago"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 mb-4">Agregar pago</h3>
            <div className="flex gap-2 mb-4">
              {onAgregarComprobante && (
                <button
                  type="button"
                  onClick={() => setAgregarPagoTipo('comprobante')}
                  disabled={agregandoPago}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${agregarPagoTipo === 'comprobante' ? 'bg-[#8B1A1A] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  Subir comprobante
                </button>
              )}
              {onAgregarPagoManual && (
                <button
                  type="button"
                  onClick={() => setAgregarPagoTipo('manual')}
                  disabled={agregandoPago}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${agregarPagoTipo === 'manual' ? 'bg-[#8B1A1A] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                >
                  Pago manual
                </button>
              )}
            </div>
            {agregarPagoTipo === 'comprobante' && onAgregarComprobante && (
              <>
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Archivo del comprobante</label>
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    disabled={agregandoPago}
                    onChange={(e) => setAgregarFile(e.target.files?.[0] || null)}
                    className="w-full text-sm text-gray-600 file:mr-2 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-[#8B1A1A]/10 file:text-[#8B1A1A] disabled:opacity-50"
                  />
                </div>
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monto depositado</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={agregarMonto}
                    onChange={(e) => setAgregarMonto(e.target.value)}
                    placeholder="Ej. 500"
                    disabled={agregandoPago}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A] disabled:opacity-50"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Moneda</label>
                  <select
                    value={agregarMoneda}
                    onChange={(e) => setAgregarMoneda(e.target.value as 'PEN' | 'USD')}
                    disabled={agregandoPago}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A] disabled:opacity-50"
                  >
                    <option value="PEN">Soles (PEN)</option>
                    <option value="USD">Dólares (USD)</option>
                  </select>
                </div>
              </>
            )}
            {agregarPagoTipo === 'manual' && onAgregarPagoManual && (
              <>
                <div className="mb-3">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Monto</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={agregarMonto}
                    onChange={(e) => setAgregarMonto(e.target.value)}
                    placeholder="Ej. 500"
                    disabled={agregandoPago}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A] disabled:opacity-50"
                  />
                </div>
                <div className="mb-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Moneda</label>
                  <select
                    value={agregarMoneda}
                    onChange={(e) => setAgregarMoneda(e.target.value as 'PEN' | 'USD')}
                    disabled={agregandoPago}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#8B1A1A] focus:border-[#8B1A1A] disabled:opacity-50"
                  >
                    <option value="PEN">Soles (PEN)</option>
                    <option value="USD">Dólares (USD)</option>
                  </select>
                </div>
              </>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setModalAgregarPago(false)}
                disabled={agregandoPago}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={agregandoPago || (agregarPagoTipo === 'comprobante' ? !agregarFile || !agregarMonto.trim() : !agregarMonto.trim())}
                className="flex-1 px-4 py-2 bg-[#8B1A1A] text-white rounded-lg hover:bg-[#6B1515] disabled:opacity-50 font-medium"
                onClick={async () => {
                  const num = parseFloat(agregarMonto.replace(',', '.'));
                  if (Number.isNaN(num) || num <= 0) return;
                  setAgregandoPago(true);
                  try {
                    if (agregarPagoTipo === 'comprobante' && agregarFile && onAgregarComprobante) {
                      await onAgregarComprobante(agregarFile, num, agregarMoneda);
                    } else if (agregarPagoTipo === 'manual' && onAgregarPagoManual) {
                      await onAgregarPagoManual(num, agregarMoneda);
                    }
                    setModalAgregarPago(false);
                    setAgregarFile(null);
                    setAgregarMonto('');
                  } finally {
                    setAgregandoPago(false);
                  }
                }}
              >
                {agregandoPago ? 'Guardando…' : agregarPagoTipo === 'comprobante' ? 'Subir y validar' : 'Registrar pago'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {comprobantePreview && createPortal(
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center p-4"
          style={{ zIndex: 9999 }}
          onClick={() => setComprobantePreview(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Vista previa comprobante"
        >
          <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <span className="text-sm font-medium text-gray-900 truncate">{comprobantePreview.fileName}</span>
              <button type="button" onClick={() => setComprobantePreview(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-600" aria-label="Cerrar">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4 overflow-auto">
              {comprobantePreview.isImage ? (
                <img src={comprobantePreview.url} alt={comprobantePreview.fileName} className="max-w-full h-auto max-h-[70vh] object-contain mx-auto" />
              ) : (
                <iframe src={comprobantePreview.url} title={comprobantePreview.fileName} className="w-full min-h-[70vh] rounded-lg border border-gray-200" />
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
