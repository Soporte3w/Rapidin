import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Bike, Check, ClipboardList, ExternalLink, FileText, Save, UserRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { MIMOTO_STATUS_LABEL, mimotoApiErrorMessage, type MimotoDetail, unwrap } from './mimotoApi';
import { MimotoLoading, MimotoPageHeader, MimotoStatusBadge } from './mimotoUi';

const FLOW = ['pendiente', 'citado', 'en_revision', 'aprobado', 'activo'];
const ALL_STATUSES = [...FLOW, 'rechazado', 'retirado', 'cancelado'];

export default function YegoMiMotoSolicitudDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<MimotoDetail | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = unwrap<MimotoDetail>(await api.get(`/mimoto/solicitudes/${id}`));
      setDetail(next);
      setStatus(next.status);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo cargar la solicitud'));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const saveStatus = async () => {
    setSaving(true);
    try {
      await api.patch(`/mimoto/solicitudes/${id}`, { status });
      toast.success('Estado actualizado');
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo actualizar el estado'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <MimotoLoading label="Cargando solicitud..." />;
  if (!detail) return <div className="py-20 text-center text-sm text-gray-500">Solicitud no encontrada.</div>;

  const currentIndex = FLOW.indexOf(detail.status);
  return (
    <div className="space-y-4 lg:space-y-6">
      <MimotoPageHeader icon={ClipboardList} title={`${detail.first_name} ${detail.last_name}`} subtitle={`${detail.document_type} ${detail.document_number} · Solicitud Mi Moto`} action={<div className="flex flex-wrap gap-2"><button type="button" onClick={() => navigate('/admin/yego-mi-moto/requests')} className="inline-flex items-center gap-2 rounded-lg bg-white/20 px-3 py-2 text-sm font-medium text-white hover:bg-white/30"><ArrowLeft className="h-4 w-4" />Solicitudes</button>{['aprobado', 'activo'].includes(detail.status) && <button type="button" onClick={() => navigate(`/admin/yego-mi-moto/rent-sale/${detail.id}`)} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-[#8B1A1A]"><Bike className="h-4 w-4" />Alquiler / Venta</button>}</div>} />

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold text-gray-900">Proceso de gestión</h2><p className="text-sm text-gray-500">Seguimiento del alta y entrega de la moto</p></div><div className="flex items-center gap-2"><select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm">{ALL_STATUSES.map((value) => <option key={value} value={value}>{MIMOTO_STATUS_LABEL[value] || value}</option>)}</select><button type="button" disabled={saving || status === detail.status} onClick={() => void saveStatus()} title="Guardar estado" className="grid h-10 w-10 place-items-center rounded-lg bg-red-600 text-white disabled:opacity-40"><Save className="h-4 w-4" /></button></div></div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5">{FLOW.map((value, index) => { const completed = currentIndex >= index; const active = detail.status === value; return <li key={value} className={`rounded-lg border px-3 py-3 ${active ? 'border-red-300 bg-red-50' : completed ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}><div className="flex items-center gap-2">{completed ? <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-green-600 text-white"><Check className="h-3.5 w-3.5" /></span> : <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-gray-300 bg-white text-xs text-gray-500">{index + 1}</span>}<span className="text-xs font-semibold text-gray-800">{MIMOTO_STATUS_LABEL[value]}</span></div></li>; })}</ol>
        {!FLOW.includes(detail.status) && <div className="mt-3"><MimotoStatusBadge status={detail.status} label={MIMOTO_STATUS_LABEL[detail.status] || detail.status} /></div>}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <InfoPanel icon={UserRound} title="Conductor" rows={[["Nombre", `${detail.first_name} ${detail.last_name}`], [detail.document_type, detail.document_number], ['Celular', `+${detail.phone}`], ['Correo', detail.email || '—'], ['Licencia', detail.license_number || '—']]} />
        <InfoPanel icon={Bike} title="Moto y Fleet" rows={[["Flota", detail.fleet_name || '—'], ['Moto', detail.vehiculo_name || 'Sin asignar'], ['Placa', detail.placa_asignada || 'Sin placa'], ['ID Fleet', detail.driver_id_fleet || '—'], ['Entrega', detail.fecha_entrega_vehiculo ? String(detail.fecha_entrega_vehiculo).slice(0, 10) : 'Por definir']]} />
        <InfoPanel icon={FileText} title="Plan financiero" rows={[["Cronograma", detail.cronograma_name || 'Sin asignar'], ['Modalidad inicial', detail.pago_tipo === 'parcial' ? 'Inicial parcial' : 'Inicial completa'], ['Estado inicial', detail.pago_estado || 'pendiente'], ['Inicio de cobro', detail.fecha_inicio_cobro_semanal ? String(detail.fecha_inicio_cobro_semanal).slice(0, 10) : 'Por definir'], ['Moneda', detail.vehiculo_moneda || 'COP']]} />
      </div>

      <section className="rounded-xl border border-gray-200 bg-white shadow-sm"><div className="border-b border-gray-200 px-4 py-3"><h2 className="font-bold text-gray-900">Documentos y observaciones</h2></div><div className="grid gap-5 p-4 md:grid-cols-2"><div><p className="text-xs font-semibold uppercase text-gray-500">Contrato</p>{detail.contratos.length === 0 ? <p className="mt-2 text-sm text-gray-500">Todavía no se ha subido un contrato.</p> : <div className="mt-2 space-y-2">{detail.contratos.map((contract) => <a key={contract.id} href={contract.file_path} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"><span>Versión {contract.version} · {contract.file_name}</span><ExternalLink className="h-4 w-4" /></a>)}</div>}</div><div><p className="text-xs font-semibold uppercase text-gray-500">Observaciones</p><p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{detail.observations || 'Sin observaciones registradas.'}</p></div></div></section>
    </div>
  );
}

function InfoPanel({ icon: Icon, title, rows }: { icon: typeof UserRound; title: string; rows: Array<[string, string]> }) {
  return <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"><h2 className="flex items-center gap-2 font-bold text-gray-900"><span className="grid h-8 w-8 place-items-center rounded-lg bg-red-50"><Icon className="h-4 w-4 text-red-700" /></span>{title}</h2><dl className="mt-4 space-y-3">{rows.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4 border-b border-gray-100 pb-2 last:border-0"><dt className="text-xs font-medium text-gray-500">{label}</dt><dd className="text-right text-sm font-semibold text-gray-800">{value}</dd></div>)}</dl></section>;
}
