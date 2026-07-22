import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCheck, Eye, FileText, Image as ImageIcon, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { formatMimotoMoney, MIMOTO_STATUS_LABEL, mimotoApiErrorMessage, type MimotoVoucher, unwrap } from './mimotoApi';
import { MimotoEmpty, MimotoLoading, MimotoPageHeader, MimotoStatusBadge } from './mimotoUi';

const FILTERS = [
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'validado', label: 'Validados' },
  { value: 'rechazado', label: 'Rechazados' },
  { value: 'todos', label: 'Todos' },
] as const;

type Filter = (typeof FILTERS)[number]['value'];

function isImage(path: string) {
  return /\.(avif|gif|jpe?g|png|webp)(?:\?|$)/i.test(path);
}

function conceptLabel(row: MimotoVoucher) {
  return row.comprobante_tipo === 'otro_gasto' ? 'Otro gasto' : 'Cuota semanal';
}

export default function YegoMiMotoPayments() {
  const [rows, setRows] = useState<MimotoVoucher[]>([]);
  const [filter, setFilter] = useState<Filter>('pendiente');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [preview, setPreview] = useState<MimotoVoucher | null>(null);
  const [rejecting, setRejecting] = useState<MimotoVoucher | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get('/mimoto/comprobantes/validacion', {
        params: { estado: filter, limit: 500 },
      });
      setRows(unwrap<MimotoVoucher[]>(response) || []);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudieron cargar los comprobantes'));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const visibleRows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es-CO');
    if (!term) return rows;
    return rows.filter((row) => [row.first_name, row.last_name, row.document_number, row.fleet_name, row.referencia]
      .some((value) => String(value || '').toLocaleLowerCase('es-CO').includes(term)));
  }, [rows, search]);

  const update = async (voucher: MimotoVoucher, estado: 'validado' | 'rechazado', motivo?: string) => {
    setUpdating(voucher.id);
    try {
      await api.patch(`/mimoto/comprobantes/${voucher.id}/estado`, {
        tipo: voucher.comprobante_tipo,
        estado,
        motivo,
      });
      toast.success(estado === 'validado' ? 'Comprobante validado' : 'Comprobante rechazado');
      setRejecting(null);
      setReason('');
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo actualizar el comprobante'));
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="space-y-4 lg:space-y-6">
      <MimotoPageHeader icon={ClipboardCheck} title="Validar comprobantes" subtitle="Control bancario de cuotas y otros gastos de Mi Moto Colombia" />

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="inline-flex w-full overflow-x-auto rounded-lg bg-gray-100 p-1 lg:w-auto">
            {FILTERS.map(({ value, label }) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`min-w-max rounded-md px-4 py-2 text-sm font-semibold transition ${filter === value ? 'bg-white text-red-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>{label}</button>
            ))}
          </div>
          <label className="relative block w-full lg:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Conductor, documento, flota o cuota" className="h-10 w-full rounded-lg border border-gray-300 pl-9 pr-3 text-sm focus:border-red-500 focus:ring-2 focus:ring-red-100" />
          </label>
        </div>
      </section>

      {loading ? <MimotoLoading label="Cargando comprobantes..." /> : visibleRows.length === 0 ? <MimotoEmpty icon={ClipboardCheck} title="No hay comprobantes" description="No existen registros para el estado o búsqueda seleccionados." /> : (
        <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500"><tr><th className="px-4 py-3">Archivo</th><th className="px-4 py-3">Conductor</th><th className="px-4 py-3">Concepto</th><th className="px-4 py-3">Monto</th><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3 text-right">Acciones</th></tr></thead>
              <tbody className="divide-y divide-gray-100">{visibleRows.map((row) => <VoucherRow key={`${row.comprobante_tipo}-${row.id}`} row={row} busy={updating === row.id} onPreview={setPreview} onApprove={(item) => void update(item, 'validado')} onReject={setRejecting} />)}</tbody>
            </table>
          </div>
          <div className="divide-y divide-gray-100 md:hidden">{visibleRows.map((row) => <VoucherCard key={`${row.comprobante_tipo}-${row.id}`} row={row} busy={updating === row.id} onPreview={setPreview} onApprove={(item) => void update(item, 'validado')} onReject={setRejecting} />)}</div>
        </section>
      )}

      {preview && <PreviewModal voucher={preview} onClose={() => setPreview(null)} />}
      {rejecting && <RejectModal voucher={rejecting} reason={reason} busy={updating === rejecting.id} onReason={setReason} onClose={() => { setRejecting(null); setReason(''); }} onConfirm={() => void update(rejecting, 'rechazado', reason.trim())} />}
    </div>
  );
}

type VoucherActions = { row: MimotoVoucher; busy: boolean; onPreview: (row: MimotoVoucher) => void; onApprove: (row: MimotoVoucher) => void; onReject: (row: MimotoVoucher) => void };

function VoucherRow({ row, busy, onPreview, onApprove, onReject }: VoucherActions) {
  return <tr className="hover:bg-gray-50/70"><td className="px-4 py-3"><VoucherThumb row={row} onClick={() => onPreview(row)} /></td><td className="px-4 py-3"><p className="font-semibold text-gray-900">{row.first_name} {row.last_name}</p><p className="text-xs text-gray-500">{row.document_type} {row.document_number} · {row.fleet_name}</p></td><td className="px-4 py-3"><p className="font-medium text-gray-800">{row.referencia}</p><p className="text-xs text-gray-500">{conceptLabel(row)} · {row.origen}</p>{row.rechazo_razon && <p className="mt-1 max-w-xs text-xs text-red-700">{row.rechazo_razon}</p>}</td><td className="px-4 py-3 font-bold">{formatMimotoMoney(row.monto, row.moneda)}</td><td className="px-4 py-3 text-gray-600">{new Date(row.created_at).toLocaleString('es-CO')}</td><td className="px-4 py-3"><MimotoStatusBadge status={row.estado} label={MIMOTO_STATUS_LABEL[row.estado] || row.estado} /></td><td className="px-4 py-3"><VoucherButtons row={row} busy={busy} onPreview={onPreview} onApprove={onApprove} onReject={onReject} /></td></tr>;
}

function VoucherCard({ row, busy, onPreview, onApprove, onReject }: VoucherActions) {
  return <article className="p-4"><div className="flex items-start gap-3"><VoucherThumb row={row} onClick={() => onPreview(row)} /><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-gray-900">{row.first_name} {row.last_name}</p><p className="text-xs text-gray-500">{row.document_type} {row.document_number}</p></div><MimotoStatusBadge status={row.estado} label={MIMOTO_STATUS_LABEL[row.estado] || row.estado} /></div><p className="mt-2 truncate text-sm text-gray-700">{row.referencia}</p><p className="mt-1 text-lg font-bold">{formatMimotoMoney(row.monto, row.moneda)}</p></div></div><div className="mt-3 border-t border-gray-100 pt-3"><VoucherButtons row={row} busy={busy} onPreview={onPreview} onApprove={onApprove} onReject={onReject} /></div></article>;
}

function VoucherThumb({ row, onClick }: { row: MimotoVoucher; onClick: () => void }) {
  return <button type="button" onClick={onClick} title="Ver comprobante" className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-gray-200 bg-gray-50">{isImage(row.file_path) ? <img src={row.file_path} alt="Comprobante" className="h-full w-full object-cover" /> : <FileText className="h-6 w-6 text-red-700" />}</button>;
}

function VoucherButtons({ row, busy, onPreview, onApprove, onReject }: VoucherActions) {
  return <div className="flex justify-end gap-2"><button type="button" onClick={() => onPreview(row)} title="Ver comprobante" className="grid h-9 w-9 place-items-center rounded-lg border border-gray-300 text-gray-600 hover:border-red-300 hover:text-red-700"><Eye className="h-4 w-4" /></button>{row.estado === 'pendiente' && <><button type="button" disabled={busy} onClick={() => onApprove(row)} title="Confirmar banco" className="grid h-9 w-9 place-items-center rounded-lg border border-green-600 text-green-700 hover:bg-green-50 disabled:opacity-40"><Check className="h-4 w-4" /></button><button type="button" disabled={busy} onClick={() => onReject(row)} title="Rechazar" className="grid h-9 w-9 place-items-center rounded-lg border border-red-600 text-red-700 hover:bg-red-50 disabled:opacity-40"><X className="h-4 w-4" /></button></>}</div>;
}

function PreviewModal({ voucher, onClose }: { voucher: MimotoVoucher; onClose: () => void }) {
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" onClick={onClose}><div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(event) => event.stopPropagation()}><header className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="font-bold text-gray-900">Comprobante de {voucher.first_name} {voucher.last_name}</h2><p className="text-sm text-gray-500">{voucher.referencia} · {formatMimotoMoney(voucher.monto, voucher.moneda)}</p></div><button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100" aria-label="Cerrar"><X className="h-5 w-5" /></button></header><div className="min-h-0 flex-1 overflow-auto bg-gray-100 p-3">{isImage(voucher.file_path) ? <img src={voucher.file_path} alt="Comprobante ampliado" className="mx-auto max-h-[75vh] max-w-full object-contain" /> : <iframe src={voucher.file_path} title="Comprobante PDF" className="h-[72vh] w-full rounded bg-white" />}</div></div></div>;
}

function RejectModal({ voucher, reason, busy, onReason, onClose, onConfirm }: { voucher: MimotoVoucher; reason: string; busy: boolean; onReason: (value: string) => void; onClose: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-lg bg-red-50"><ImageIcon className="h-5 w-5 text-red-700" /></span><div><h2 className="font-bold text-gray-900">Rechazar comprobante</h2><p className="text-sm text-gray-500">{voucher.first_name} {voucher.last_name}</p></div></div><label className="mt-4 block text-sm font-medium text-gray-700">Motivo<textarea autoFocus value={reason} onChange={(event) => onReason(event.target.value)} rows={4} className="mt-1.5 w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-red-500 focus:ring-2 focus:ring-red-100" /></label><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-medium">Cancelar</button><button type="button" disabled={busy || !reason.trim()} onClick={onConfirm} className="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-40">Confirmar rechazo</button></div></div></div>;
}
