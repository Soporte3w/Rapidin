import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Bike, CalendarDays, ChevronDown, FileText, Image as ImageIcon, Receipt, Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { fetchMimotoConfig, formatMimotoMoney, MIMOTO_STATUS_LABEL, type MimotoCurrency, type MimotoDetail, type MimotoExpense, type MimotoPublicConfig, type MimotoQuota, type MimotoSolicitud, unwrap } from '../yegoMiMoto/mimotoApi';
import { MimotoLoading, MimotoStatusBadge } from '../yegoMiMoto/mimotoUi';

type SectionKey = 'moto' | 'cuotas' | 'gastos';
type PaymentTarget = { kind: 'quota'; row: MimotoQuota } | { kind: 'expense'; row: MimotoExpense };

export default function QuieroMiYegoMoto() {
  const [requests, setRequests] = useState<MimotoSolicitud[]>([]);
  const [detail, setDetail] = useState<MimotoDetail | null>(null);
  const [config, setConfig] = useState<MimotoPublicConfig | null>(null);
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({ moto: true, cuotas: true, gastos: false });
  const [payment, setPayment] = useState<PaymentTarget | null>(null);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<MimotoCurrency>('COP');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(unwrap<MimotoDetail>(await api.get(`/mimoto/solicitudes/${id}`)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listResponse, publicConfig] = await Promise.all([
        api.get('/mimoto/solicitudes', { params: { limit: 20 } }),
        fetchMimotoConfig(),
      ]);
      const rows = unwrap<{ data: MimotoSolicitud[] }>(listResponse)?.data || [];
      setRequests(rows);
      setConfig(publicConfig);
      if (rows[0]) await loadDetail(rows[0].id); else setDetail(null);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'No se pudo cargar Mi Moto');
    } finally {
      setLoading(false);
    }
  }, [loadDetail]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const totals = useMemo(() => (detail?.cuotas || []).reduce((result, quota) => ({
    paid: result.paid + Number(quota.paid_amount || 0),
    overdue: result.overdue + (quota.status === 'overdue' ? 1 : 0),
    balance: result.balance + Number(quota.saldo_total || 0),
  }), { paid: 0, overdue: 0, balance: 0 }), [detail]);

  const startPayment = (target: PaymentTarget) => {
    const balance = target.kind === 'quota' ? Number(target.row.saldo_total) : Math.max(0, Number(target.row.amount_due) - Number(target.row.paid_amount));
    setPayment(target);
    setAmount(String(balance));
    setCurrency(target.row.moneda);
    setFile(null);
    setPreviewUrl('');
  };

  const chooseFile = (nextFile: File | null) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(nextFile);
    setPreviewUrl(nextFile?.type.startsWith('image/') ? URL.createObjectURL(nextFile) : '');
  };

  const submitVoucher = async () => {
    if (!detail || !payment || !file) return toast.error('Selecciona el comprobante');
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return toast.error('Ingresa un monto válido');
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    form.append('monto', amount);
    form.append('moneda', currency);
    const resource = payment.kind === 'quota' ? `cuotas/${payment.row.id}` : `otros-gastos/${payment.row.id}`;
    try {
      await api.post(`/mimoto/solicitudes/${detail.id}/${resource}/comprobantes`, form);
      toast.success('Comprobante enviado');
      setPayment(null);
      await loadDetail(detail.id);
    } catch (error: any) {
      toast.error(error?.response?.data?.message || 'No se pudo subir el comprobante');
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <MimotoLoading label="Cargando tu información Mi Moto..." />;
  if (!detail) return <div className="rounded-lg border border-gray-200 bg-white p-8 text-center"><Bike className="mx-auto h-9 w-9 text-gray-400" /><h1 className="mt-3 text-lg font-bold">Yego Mi Moto</h1><p className="mt-1 text-sm text-gray-500">Aún no tienes una solicitud Mi Moto vinculada a tu teléfono.</p></div>;

  const defaultCurrency = detail.vehiculo_moneda === 'USD' ? 'USD' : 'COP';
  return <div className="mx-auto max-w-5xl space-y-3 pb-6">
    <header className="overflow-hidden rounded-lg bg-[#991B1B] text-white shadow-sm"><div className="grid gap-4 p-5 sm:grid-cols-[96px_1fr] sm:items-center">{detail.vehiculo_metadata?.image ? <img src={detail.vehiculo_metadata.image} alt={detail.vehiculo_name || 'Moto asignada'} className="h-24 w-24 rounded-lg bg-white object-cover" /> : <div className="grid h-24 w-24 place-items-center rounded-lg bg-white/15"><Bike className="h-10 w-10" /></div>}<div><p className="text-sm font-medium text-red-100">Yego Mi Moto Colombia</p><h1 className="mt-1 text-xl font-bold">{detail.first_name} {detail.last_name}</h1><p className="mt-1 text-sm text-red-100">{detail.vehiculo_name || 'Moto por asignar'} · {detail.placa_asignada || detail.fleet_name}</p></div></div></header>

    {requests.length > 1 && <select value={detail.id} onChange={(event) => void loadDetail(event.target.value)} className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">{requests.map((row) => <option key={row.id} value={row.id}>{row.placa_asignada || row.document_number} · {row.fleet_name}</option>)}</select>}
    {!config?.enabled && <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">Puedes consultar tu contrato. La carga de pagos se habilitará cuando inicie la operación.</div>}

    <section className="grid grid-cols-3 gap-2"><Metric label="Pagado" value={formatMimotoMoney(totals.paid, defaultCurrency)} tone="green" /><Metric label="Vencidas" value={String(totals.overdue)} tone="red" /><Metric label="Pendiente" value={formatMimotoMoney(totals.balance, defaultCurrency)} tone="orange" /></section>

    <Accordion title="Tu moto asignada" icon={Bike} active={open.moto} onClick={() => setOpen((current) => ({ ...current, moto: !current.moto }))}>
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4"><Field label="Moto" value={detail.vehiculo_name || 'Sin asignar'} /><Field label="Placa" value={detail.placa_asignada || 'Sin placa'} /><Field label="Flota" value={detail.fleet_name || '—'} /><Field label="Estado" value={MIMOTO_STATUS_LABEL[detail.status] || detail.status} /><Field label="Cronograma" value={detail.cronograma_name || '—'} /><Field label="Inicio de cobro" value={detail.fecha_inicio_cobro_semanal ? String(detail.fecha_inicio_cobro_semanal).slice(0, 10) : 'Por definir'} /></div>
      {detail.contratos.length > 0 && <div className="border-t border-gray-100 p-4"><p className="mb-2 text-xs font-semibold uppercase text-gray-500">Contrato</p><div className="flex flex-wrap gap-2">{detail.contratos.map((contract) => <a key={contract.id} href={contract.file_path} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3 py-2 text-sm font-semibold text-red-700"><FileText className="h-4 w-4" />Versión {contract.version}</a>)}</div></div>}
    </Accordion>

    <Accordion title="Cuotas" icon={CalendarDays} active={open.cuotas} onClick={() => setOpen((current) => ({ ...current, cuotas: !current.cuotas }))}>
      <div className="divide-y divide-gray-100">{detail.cuotas.length === 0 ? <p className="p-6 text-center text-sm text-gray-500">Aún no hay cuotas.</p> : detail.cuotas.map((quota) => <div key={quota.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-gray-900">Semana {quota.week_number}</p><MimotoStatusBadge status={quota.status} label={MIMOTO_STATUS_LABEL[quota.status] || quota.status} /></div><p className="mt-1 text-xs text-gray-500">Vence {String(quota.due_date).slice(0, 10)} · {quota.viajes} viajes</p><p className="mt-1 text-xs text-red-600">Mora {formatMimotoMoney(quota.saldo_mora, quota.moneda)} · Extra {formatMimotoMoney(quota.saldo_mora_extra, quota.moneda)}</p></div><div className="sm:text-right"><p className="text-xs text-gray-500">Pendiente</p><p className="text-base font-bold text-gray-900">{formatMimotoMoney(quota.saldo_total, quota.moneda)}</p></div>{Number(quota.saldo_total) > 0.005 && <button type="button" disabled={!config?.enabled} onClick={() => startPayment({ kind: 'quota', row: quota })} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-40"><Upload className="h-4 w-4" />Pagar</button>}</div>)}</div>
    </Accordion>

    <Accordion title="Otros gastos" icon={Receipt} active={open.gastos} onClick={() => setOpen((current) => ({ ...current, gastos: !current.gastos }))}>
      <div className="divide-y divide-gray-100">{detail.otros_gastos.length === 0 ? <p className="p-6 text-center text-sm text-gray-500">No hay otros gastos registrados.</p> : detail.otros_gastos.map((expense) => {
        const balance = Math.max(0, Number(expense.amount_due) - Number(expense.paid_amount));
        return <div key={expense.id} className="grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] sm:items-center"><div><p className="text-sm font-bold capitalize text-gray-900">{expense.tipo.replace(/_/g, ' ')}</p><p className="mt-1 text-xs text-gray-500">Cuota {expense.numero_cuota}/{expense.total_cuotas} · {String(expense.due_date).slice(0, 10)}</p></div><div className="sm:text-right"><p className="text-xs text-gray-500">Pendiente</p><p className="font-bold">{formatMimotoMoney(balance, expense.moneda)}</p></div>{balance > 0.005 && <button type="button" disabled={!config?.enabled} onClick={() => startPayment({ kind: 'expense', row: expense })} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-700 disabled:opacity-40"><Upload className="h-4 w-4" />Pagar</button>}</div>;
      })}</div>
    </Accordion>

    {payment && <PaymentModal target={payment} amount={amount} currency={currency} file={file} previewUrl={previewUrl} uploading={uploading} onAmount={setAmount} onCurrency={setCurrency} onFile={chooseFile} onClose={() => setPayment(null)} onSubmit={() => void submitVoucher()} />}
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'green' | 'red' | 'orange' }) {
  const styles = tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-700' : 'text-orange-700';
  return <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-3 text-center shadow-sm"><p className="text-[11px] font-semibold uppercase text-gray-500">{label}</p><p className={`mt-1 truncate text-sm font-bold sm:text-base ${styles}`}>{value}</p></div>;
}

function Accordion({ title, icon: Icon, active, onClick, children }: { title: string; icon: typeof Bike; active: boolean; onClick: () => void; children: ReactNode }) {
  return <section className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"><button type="button" onClick={onClick} className="flex w-full items-center justify-between p-4 text-left"><span className="flex items-center gap-2 text-sm font-bold text-gray-900"><Icon className="h-4 w-4 text-red-700" />{title}</span><ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${active ? 'rotate-180' : ''}`} /></button>{active && <div className="border-t border-gray-100">{children}</div>}</section>;
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-semibold uppercase text-gray-500">{label}</p><p className="mt-1 text-sm font-semibold text-gray-900">{value}</p></div>;
}

function PaymentModal({ target, amount, currency, file, previewUrl, uploading, onAmount, onCurrency, onFile, onClose, onSubmit }: { target: PaymentTarget; amount: string; currency: MimotoCurrency; file: File | null; previewUrl: string; uploading: boolean; onAmount: (value: string) => void; onCurrency: (value: MimotoCurrency) => void; onFile: (file: File | null) => void; onClose: () => void; onSubmit: () => void }) {
  const title = target.kind === 'quota' ? `Pagar semana ${target.row.week_number}` : `Pagar ${target.row.tipo.replace(/_/g, ' ')}`;
  return <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true"><div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-lg bg-white shadow-xl sm:rounded-lg"><header className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="font-bold text-gray-900">{title}</h2><p className="text-sm text-gray-500">Indica el valor real del comprobante</p></div><button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button></header><div className="space-y-4 p-5"><div className="grid grid-cols-[1fr_130px] gap-3"><label className="text-sm font-medium text-gray-700">Monto<input type="number" min="0.01" value={amount} onChange={(event) => onAmount(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3" /></label><label className="text-sm font-medium text-gray-700">Moneda<select value={currency} onChange={(event) => onCurrency(event.target.value as MimotoCurrency)} className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="COP">COP</option><option value="USD">USD</option></select></label></div><label className="block cursor-pointer rounded-lg border-2 border-dashed border-gray-300 p-4 text-center hover:border-red-300"><input type="file" accept="image/*,application/pdf" className="sr-only" onChange={(event) => onFile(event.target.files?.[0] || null)} />{previewUrl ? <img src={previewUrl} alt="Vista previa" className="mx-auto max-h-48 rounded object-contain" /> : file ? <div><FileText className="mx-auto h-8 w-8 text-red-700" /><p className="mt-2 truncate text-sm font-medium">{file.name}</p></div> : <div><ImageIcon className="mx-auto h-8 w-8 text-gray-400" /><p className="mt-2 text-sm font-medium text-gray-700">Elegir comprobante</p><p className="text-xs text-gray-500">Imagen o PDF</p></div>}</label><button type="button" disabled={uploading || !file || Number(amount) <= 0} onClick={onSubmit} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-red-600 text-sm font-semibold text-white disabled:opacity-40"><Upload className="h-4 w-4" />{uploading ? 'Enviando...' : 'Enviar comprobante'}</button></div></div></div>;
}
