import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Banknote,
  Bike,
  Calendar,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  MessageCircle,
  Plus,
  Receipt,
  RefreshCw,
  Send,
  Tag,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../services/api';
import {
  fetchMimotoConfig,
  formatMimotoMoney,
  MIMOTO_STATUS_LABEL,
  mimotoApiErrorMessage,
  type MimotoCurrency,
  type MimotoDetail,
  type MimotoExpense,
  type MimotoFleetEvidence,
  type MimotoPublicConfig,
  type MimotoQuota,
  type MimotoQuotaVoucher,
  unwrap,
} from './mimotoApi';
import { MimotoLoading, MimotoPagination, MimotoStatusBadge } from './mimotoUi';

type Tab = 'cuotas' | 'gastos';
type QuotaDetailTab = 'comprobantes' | 'fleet';
type WhatsAppTab = 'cuotas' | 'metricas' | 'comprobante';
type PaymentTarget = { kind: 'quota'; row: MimotoQuota } | { kind: 'expense'; row: MimotoExpense };
type QuotaPreview = {
  cuota?: {
    cuota_semanal: number | string;
    recaudo_aplicado: number | string;
    amount_due: number | string;
    moneda: MimotoCurrency;
  };
};
type CascadeSimulation = {
  applied: number | string;
  remaining: number | string;
  target_currency: MimotoCurrency;
  applications?: unknown[];
};

function money(value: unknown, currency: MimotoCurrency) {
  return formatMimotoMoney(value, currency);
}

function formatDateOnly(value?: string | null) {
  const iso = String(value || '').slice(0, 10);
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

export default function YegoMiMotoDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const listState = (location.state || {}) as Record<string, unknown>;
  const contractFileRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<MimotoDetail | null>(null);
  const [config, setConfig] = useState<MimotoPublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('cuotas');
  const [expandedQuotaId, setExpandedQuotaId] = useState<string | null>(null);
  const [quotaDetailTab, setQuotaDetailTab] = useState<QuotaDetailTab>('comprobantes');
  const [quotaPage, setQuotaPage] = useState(1);
  const [quotaPageSize, setQuotaPageSize] = useState(10);
  const [contractMenuOpen, setContractMenuOpen] = useState(false);
  const [contractToDelete, setContractToDelete] = useState<MimotoDetail['contratos'][number] | null>(null);
  const [quotaModal, setQuotaModal] = useState(false);
  const [quotaForm, setQuotaForm] = useState({ week_start_date: '', viajes: '', horas_conectadas: '', partner_fees: '' });
  const [quotaPreview, setQuotaPreview] = useState<QuotaPreview | null>(null);
  const [cascadeOpen, setCascadeOpen] = useState(false);
  const [available, setAvailable] = useState('');
  const [simulation, setSimulation] = useState<CascadeSimulation | null>(null);
  const [payment, setPayment] = useState<PaymentTarget | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentCurrency, setPaymentCurrency] = useState<MimotoCurrency>('COP');
  const [paymentFile, setPaymentFile] = useState<File | null>(null);
  const [whatsAppOpen, setWhatsAppOpen] = useState(false);
  const [whatsAppTab, setWhatsAppTab] = useState<WhatsAppTab>('cuotas');
  const [whatsAppMessage, setWhatsAppMessage] = useState('');
  const [whatsAppVoucherId, setWhatsAppVoucherId] = useState('');
  const [refreshingWhatsAppPhone, setRefreshingWhatsAppPhone] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [response, publicConfig] = await Promise.all([
        api.get(`/mimoto/solicitudes/${id}`),
        fetchMimotoConfig(),
      ]);
      setDetail(unwrap<MimotoDetail>(response));
      setConfig(publicConfig);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo cargar el contrato'));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => (detail?.cuotas || []).reduce((result, row) => {
    const balance = Number(row.saldo_total || 0);
    const isPaid = balance <= 0.005 || row.status === 'paid' || row.status === 'bonificada';
    return {
      paid: result.paid + Number(row.paid_amount || 0),
      paidCount: result.paidCount + (isPaid ? 1 : 0),
      balance: result.balance + balance,
      overdue: result.overdue + (row.status === 'overdue' ? 1 : 0),
      overdueBalance: result.overdueBalance + (row.status === 'overdue' ? balance : 0),
    };
  }, { paid: 0, paidCount: 0, balance: 0, overdue: 0, overdueBalance: 0 }), [detail]);

  const totalQuotaPages = Math.max(1, Math.ceil((detail?.cuotas.length || 0) / quotaPageSize));
  const visibleQuotas = useMemo(() => {
    const start = (quotaPage - 1) * quotaPageSize;
    return (detail?.cuotas || []).slice(start, start + quotaPageSize);
  }, [detail, quotaPage, quotaPageSize]);
  const whatsAppVouchers = useMemo(
    () => (detail?.comprobantes_cuota || []).filter((voucher) => Boolean(voucher.file_path)),
    [detail],
  );
  const selectedWhatsAppVoucher = useMemo(
    () => whatsAppVouchers.find((voucher) => voucher.id === whatsAppVoucherId) || whatsAppVouchers[0] || null,
    [whatsAppVoucherId, whatsAppVouchers],
  );

  useEffect(() => {
    setQuotaPage((current) => Math.min(current, totalQuotaPages));
  }, [totalQuotaPages]);

  const uploadContract = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    setSaving(true);
    try {
      await api.post(`/mimoto/solicitudes/${id}/contratos`, form);
      setContractMenuOpen(false);
      toast.success('Contrato subido');
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo subir el contrato'));
    } finally {
      setSaving(false);
    }
  };

  const deleteContract = async () => {
    if (!contractToDelete) return;
    try {
      await api.delete(`/mimoto/solicitudes/${id}/contratos/${contractToDelete.id}`);
      setContractToDelete(null);
      toast.success('Contrato eliminado');
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo eliminar el contrato'));
    }
  };

  const previewQuota = async (generate = false) => {
    setSaving(true);
    try {
      const response = await api.post(`/mimoto/solicitudes/${id}/cuotas/generar`, {
        week_start_date: quotaForm.week_start_date,
        due_date: quotaForm.week_start_date,
        viajes: Number(quotaForm.viajes),
        horas_conectadas: detail?.modo_evaluacion === 'viajes_horas' ? Number(quotaForm.horas_conectadas) : null,
        partner_fees: Number(quotaForm.partner_fees),
        dry_run: !generate,
      });
      const result = unwrap<QuotaPreview>(response);
      setQuotaPreview(result);
      if (generate) {
        toast.success('Cuota generada');
        setQuotaModal(false);
        setQuotaPreview(null);
        await load();
      }
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo procesar la cuota'));
    } finally {
      setSaving(false);
    }
  };

  const simulateCascade = async () => {
    try {
      const response = await api.post(`/mimoto/solicitudes/${id}/cobros/fleet/simular`, {
        saldo_disponible: Number(available),
        moneda: 'COP',
      });
      setSimulation(unwrap<CascadeSimulation>(response));
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo simular la cascada'));
    }
  };

  const openPayment = (target: PaymentTarget) => {
    const balance = target.kind === 'quota'
      ? Number(target.row.saldo_total)
      : Math.max(0, Number(target.row.amount_due) - Number(target.row.paid_amount));
    setPayment(target);
    setPaymentAmount(String(balance));
    setPaymentCurrency(target.row.moneda);
    setPaymentFile(null);
  };

  const submitPayment = async () => {
    if (!payment || Number(paymentAmount) <= 0) return toast.error('Ingresa un monto válido');
    setSaving(true);
    try {
      const base = `/mimoto/solicitudes/${id}/${payment.kind === 'quota' ? `cuotas/${payment.row.id}` : `otros-gastos/${payment.row.id}`}`;
      if (paymentFile) {
        const form = new FormData();
        form.append('file', paymentFile);
        form.append('monto', paymentAmount);
        form.append('moneda', paymentCurrency);
        await api.post(`${base}/comprobantes`, form);
        toast.success('Comprobante subido y pago aplicado');
      } else {
        await api.post(`${base}/pago-manual`, { monto: Number(paymentAmount), moneda: paymentCurrency });
        toast.success('Pago manual aplicado');
      }
      setPayment(null);
      await load();
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo aplicar el pago'));
    } finally {
      setSaving(false);
    }
  };

  const uploadQuotaVoucher = async (
    row: MimotoQuota,
    amount: number,
    voucherCurrency: MimotoCurrency,
    file: File,
  ) => {
    if (!config?.enabled) {
      toast.error('Mi Moto permanece en modo preparación');
      return false;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error('Ingresa un monto válido');
      return false;
    }

    const form = new FormData();
    form.append('file', file);
    form.append('monto', String(amount));
    form.append('moneda', voucherCurrency);

    try {
      await api.post(`/mimoto/solicitudes/${id}/cuotas/${row.id}/comprobantes`, form);
      toast.success('Comprobante subido y pago aplicado');
      await load();
      return true;
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo subir el comprobante'));
      return false;
    }
  };

  const openWhatsApp = () => {
    if (!detail) return;
    setWhatsAppTab('cuotas');
    setWhatsAppVoucherId(whatsAppVouchers[0]?.id || '');
    setWhatsAppMessage(buildQuotaWhatsAppMessage(detail));
    setWhatsAppOpen(true);
  };

  const changeWhatsAppTab = (nextTab: WhatsAppTab) => {
    if (!detail) return;
    setWhatsAppTab(nextTab);
    if (nextTab === 'metricas') {
      setWhatsAppMessage(buildMetricsWhatsAppMessage(detail));
    } else if (nextTab === 'comprobante') {
      setWhatsAppMessage(buildVoucherWhatsAppMessage(detail, selectedWhatsAppVoucher));
    } else {
      setWhatsAppMessage(buildQuotaWhatsAppMessage(detail));
    }
  };

  const selectWhatsAppVoucher = (voucherId: string) => {
    if (!detail) return;
    const voucher = whatsAppVouchers.find((item) => item.id === voucherId) || null;
    setWhatsAppVoucherId(voucherId);
    setWhatsAppMessage(buildVoucherWhatsAppMessage(detail, voucher));
  };

  const refreshWhatsAppPhone = async () => {
    setRefreshingWhatsAppPhone(true);
    try {
      const response = await api.post(`/mimoto/solicitudes/${id}/whatsapp-phone/refresh`);
      const result = unwrap<{ phone_after?: string; updated?: boolean; warnings?: string[] }>(response);
      if (result.phone_after) {
        setDetail((current) => current ? { ...current, phone: result.phone_after! } : current);
      }
      if (result.updated) toast.success('Número actualizado desde Fleet');
      else if (result.phone_after) toast('El número ya estaba actualizado');
      else toast.error(result.warnings?.[0] || 'Fleet no devolvió un teléfono válido');
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo actualizar el teléfono'));
    } finally {
      setRefreshingWhatsAppPhone(false);
    }
  };

  const sendWhatsApp = async () => {
    if (!whatsAppMessage.trim()) return toast.error('Escribe un mensaje');
    if (whatsAppTab === 'comprobante' && !selectedWhatsAppVoucher) {
      return toast.error('Selecciona un comprobante con archivo disponible');
    }
    setSendingWhatsApp(true);
    try {
      await api.post(`/mimoto/solicitudes/${id}/mensajes`, {
        message: whatsAppMessage.trim(),
        voucher_id: whatsAppTab === 'comprobante' ? selectedWhatsAppVoucher?.id : undefined,
      });
      toast.success(whatsAppTab === 'comprobante' ? 'Comprobante agregado a la cola' : 'Mensaje agregado a la cola');
      setWhatsAppOpen(false);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo enviar el mensaje'));
    } finally {
      setSendingWhatsApp(false);
    }
  };

  if (loading) return <MimotoLoading label="Cargando contrato Mi Moto..." />;
  if (!detail) return <div className="py-20 text-center text-sm text-gray-500">Contrato no encontrado.</div>;

  const currency: MimotoCurrency = detail.vehiculo_moneda === 'USD' ? 'USD' : 'COP';
  const requiresConnectedHours = detail.modo_evaluacion === 'viajes_horas';
  const planQuotas = Number(detail.cuotas_semanales_plan || detail.cuotas_semanales || detail.cuotas.length);
  const activeContract = detail.contratos[0] || null;
  const quotaFormIncomplete = !quotaForm.week_start_date
    || (requiresConnectedHours && quotaForm.horas_conectadas === '');

  return (
    <div className="space-y-6">
      <header className="rounded-lg bg-[#8B1A1A] p-4 lg:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#6B1515]">
              <Banknote className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight text-white lg:text-xl">
                {detail.first_name} {detail.last_name}
              </h1>
              <p className="mt-0.5 text-xs text-white/90 lg:text-sm">Cronograma y métricas del contrato</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setQuotaModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/25"
            >
              <Plus className="h-4 w-4" />
              Cuota
            </button>
            <button
              type="button"
              onClick={openWhatsApp}
              className="inline-flex items-center gap-2 rounded-lg bg-[#25D366]/20 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-[#25D366]/40"
            >
              <MessageCircle className="h-4 w-4" />
              WhatsApp
            </button>
            <input
              ref={contractFileRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void uploadContract(file);
              }}
            />
            <div className="relative">
              <button
                type="button"
                onClick={() => setContractMenuOpen((current) => !current)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/25"
              >
                <FileText className="h-4 w-4" />
                Contrato
                <ChevronDown className={`h-4 w-4 transition-transform ${contractMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {contractMenuOpen && (
                <div className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl">
                  <div className="border-b border-gray-100 px-3 py-2">
                    <p className="text-xs font-semibold uppercase text-gray-500">Contrato</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-gray-900">
                      {activeContract?.file_name || 'Sin contrato activo'}
                    </p>
                  </div>
                  <div className="py-1">
                    {activeContract && (
                      <a
                        href={activeContract.file_path}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setContractMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      >
                        <ExternalLink className="h-4 w-4 text-gray-500" />
                        Ver contrato
                      </a>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => contractFileRef.current?.click()}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <Upload className="h-4 w-4 text-gray-500" />
                      {saving ? 'Subiendo...' : activeContract ? 'Volver a subir' : 'Subir contrato'}
                    </button>
                    {activeContract && (
                      <button
                        type="button"
                        onClick={() => { setContractMenuOpen(false); setContractToDelete(activeContract); }}
                        className="flex w-full items-center gap-2 border-t border-gray-100 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        Eliminar contrato
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <button
        type="button"
        onClick={() => navigate('/admin/yego-mi-moto/rent-sale', { state: listState.fromList ? listState : undefined })}
        className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-[#8B1A1A]"
      >
        <ArrowLeft className="h-4 w-4" />
        Volver a Alquiler / Venta
      </button>

      {!config?.enabled && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Mi Moto está en preparación. Las consultas y simulaciones están disponibles; los pagos reales permanecen bloqueados.
        </div>
      )}

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard icon={Calendar} label="Cuotas" value={`${totals.paidCount} / ${planQuotas}`} note="pagadas del plan" />
        <MetricCard icon={TrendingUp} label="Vencidas" value={String(totals.overdue)} alert={totals.overdue > 0} />
        <MetricCard icon={Banknote} label="Total pagado" value={money(totals.paid, currency)} success />
        <MetricCard icon={Banknote} label="Vencido" value={money(totals.overdueBalance, currency)} note="saldo en cuotas vencidas" alert={totals.overdueBalance > 0} />
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-semibold uppercase text-[#8B1A1A]">Datos del contrato</h2>
        <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <ContractDatum icon={UserRound} label={detail.document_type} value={detail.document_number} />
          <ContractDatum icon={FileText} label="Cronograma" value={detail.cronograma_name || '—'} />
          <ContractDatum icon={Bike} label="Moto" value={detail.vehiculo_name || '—'} />
          <ContractDatum icon={Tag} label="Placa" value={detail.placa_asignada || '—'} mono />
          <ContractDatum icon={Calendar} label="Inicio cobro" value={formatDateOnly(detail.fecha_inicio_cobro_semanal)} />
        </div>
      </section>

      <section className="relative min-h-[200px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <nav className="flex gap-0.5 border-b border-gray-200 px-2 sm:px-3" aria-label="Cronograma y otros gastos">
          <TabButton active={tab === 'cuotas'} onClick={() => setTab('cuotas')} icon={CalendarDays}>Cronograma semanal</TabButton>
          <TabButton active={tab === 'gastos'} onClick={() => setTab('gastos')} icon={Receipt}>Otros gastos</TabButton>
        </nav>

        {tab === 'cuotas' ? (
          <QuotaSchedule
            rows={visibleQuotas}
            totalRows={detail.cuotas.length}
            currentPage={quotaPage}
            pageSize={quotaPageSize}
            requiresConnectedHours={requiresConnectedHours}
            moraRate={Number(detail.tasa_interes_mora || 0)}
            canPay={Boolean(config?.enabled)}
            expandedQuotaId={expandedQuotaId}
            detailTab={quotaDetailTab}
            vouchers={detail.comprobantes_cuota || []}
            fleetEvidence={detail.evidencias_fleet || []}
            onPage={setQuotaPage}
            onPageSize={(size) => { setQuotaPageSize(size); setQuotaPage(1); }}
            onPay={(row) => openPayment({ kind: 'quota', row })}
            onToggle={(row) => {
              setExpandedQuotaId((current) => current === row.id ? null : row.id);
              setQuotaDetailTab('comprobantes');
            }}
            onDetailTab={setQuotaDetailTab}
            onUploadVoucher={uploadQuotaVoucher}
          />
        ) : (
          <ExpenseSchedule
            rows={detail.otros_gastos}
            canPay={Boolean(config?.enabled)}
            onPay={(row) => openPayment({ kind: 'expense', row })}
          />
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-bold text-gray-900">Cascada Fleet</h2>
            <p className="text-sm text-gray-500">Vista previa de distribución: mora, mora extra y capital</p>
          </div>
          <button
            type="button"
            onClick={() => setCascadeOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
          >
            <RefreshCw className="h-4 w-4" />
            Simular cascada
          </button>
        </div>
      </section>

      {contractToDelete && (
        <Modal title="Eliminar contrato" onClose={() => setContractToDelete(null)}>
          <p className="text-sm text-gray-600">
            Se eliminará la versión {contractToDelete.version} del contrato. La acción quedará registrada en la trazabilidad.
          </p>
          <ModalActions>
            <SecondaryButton onClick={() => setContractToDelete(null)}>Cancelar</SecondaryButton>
            <PrimaryButton onClick={() => void deleteContract()}>Eliminar contrato</PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {quotaModal && (
        <Modal title="Generar cuota semanal" onClose={() => { setQuotaModal(false); setQuotaPreview(null); }}>
          <div className={`grid gap-3 ${requiresConnectedHours ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
            <FormField label="Semana"><input type="date" value={quotaForm.week_start_date} onChange={(event) => setQuotaForm({ ...quotaForm, week_start_date: event.target.value })} className="mt-1 h-10 w-full rounded-lg border px-3" /></FormField>
            <FormField label="Viajes"><input type="number" min="0" value={quotaForm.viajes} onChange={(event) => setQuotaForm({ ...quotaForm, viajes: event.target.value })} className="mt-1 h-10 w-full rounded-lg border px-3" /></FormField>
            {requiresConnectedHours && <FormField label="Horas conectadas"><input type="number" min="0" step="0.01" value={quotaForm.horas_conectadas} onChange={(event) => setQuotaForm({ ...quotaForm, horas_conectadas: event.target.value })} className="mt-1 h-10 w-full rounded-lg border px-3" /></FormField>}
            <FormField label="Ingresos COP"><input type="number" min="0" value={quotaForm.partner_fees} onChange={(event) => setQuotaForm({ ...quotaForm, partner_fees: event.target.value })} className="mt-1 h-10 w-full rounded-lg border px-3" /></FormField>
          </div>
          {quotaPreview?.cuota && (
            <div className="mt-4 grid gap-2 rounded-lg bg-gray-50 p-3 text-sm sm:grid-cols-3">
              <p>Cuota <strong>{money(quotaPreview.cuota.cuota_semanal, quotaPreview.cuota.moneda)}</strong></p>
              <p>Recaudo <strong>{money(quotaPreview.cuota.recaudo_aplicado, quotaPreview.cuota.moneda)}</strong></p>
              <p>Pendiente <strong>{money(quotaPreview.cuota.amount_due, quotaPreview.cuota.moneda)}</strong></p>
            </div>
          )}
          <ModalActions>
            <SecondaryButton disabled={quotaFormIncomplete || saving} onClick={() => void previewQuota(false)}>Simular</SecondaryButton>
            <PrimaryButton disabled={!config?.enabled || quotaFormIncomplete || saving} onClick={() => void previewQuota(true)}>Generar cuota</PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {cascadeOpen && (
        <Modal title="Simular cascada Fleet" onClose={() => setCascadeOpen(false)}>
          <p className="text-sm text-gray-500">No retira dinero; muestra cómo se distribuiría el saldo.</p>
          <div className="mt-4 flex gap-2">
            <input type="number" min="1" value={available} onChange={(event) => setAvailable(event.target.value)} placeholder="Saldo disponible COP" className="h-10 flex-1 rounded-lg border px-3 text-sm" />
            <PrimaryButton disabled={Number(available) <= 0} onClick={() => void simulateCascade()}>Simular</PrimaryButton>
          </div>
          {simulation && (
            <div className="mt-4 rounded-lg bg-gray-50 p-4 text-sm">
              <p>Aplicado: <strong>{money(simulation.applied, simulation.target_currency)}</strong></p>
              <p>Sin aplicar: <strong>{money(simulation.remaining, simulation.target_currency)}</strong></p>
              <p className="mt-1 text-gray-500">{simulation.applications?.length || 0} cuotas afectadas</p>
            </div>
          )}
        </Modal>
      )}

      {payment && (
        <Modal title={payment.kind === 'quota' ? `Pagar semana ${payment.row.week_number}` : `Pagar ${payment.row.tipo.replace(/_/g, ' ')}`} onClose={() => setPayment(null)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Monto"><input type="number" min="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="mt-1 h-10 w-full rounded-lg border px-3" /></FormField>
            <FormField label="Moneda"><select value={paymentCurrency} onChange={(event) => setPaymentCurrency(event.target.value as MimotoCurrency)} className="mt-1 h-10 w-full rounded-lg border bg-white px-3"><option value="COP">COP</option><option value="USD">USD</option></select></FormField>
          </div>
          <FormField label="Comprobante opcional" className="mt-4"><input type="file" accept="image/*,application/pdf" onChange={(event) => setPaymentFile(event.target.files?.[0] || null)} className="mt-2 block w-full text-sm" /></FormField>
          <p className="mt-2 text-xs text-gray-500">Sin archivo se registra como pago manual; con archivo pasa a validación bancaria.</p>
          <ModalActions><PrimaryButton disabled={saving} onClick={() => void submitPayment()}>Confirmar pago</PrimaryButton></ModalActions>
        </Modal>
      )}

      {whatsAppOpen && (
        <WhatsAppModal
          detail={detail}
          tab={whatsAppTab}
          message={whatsAppMessage}
          vouchers={whatsAppVouchers}
          selectedVoucher={selectedWhatsAppVoucher}
          refreshingPhone={refreshingWhatsAppPhone}
          disabled={!config?.enabled || sendingWhatsApp}
          moduleEnabled={Boolean(config?.enabled)}
          onTab={changeWhatsAppTab}
          onVoucher={selectWhatsAppVoucher}
          onRefreshPhone={() => void refreshWhatsAppPhone()}
          onMessage={setWhatsAppMessage}
          onClose={() => setWhatsAppOpen(false)}
          onSend={() => void sendWhatsApp()}
        />
      )}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, note, alert = false, success = false }: {
  icon: typeof Calendar;
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
  success?: boolean;
}) {
  const tone = alert ? 'text-red-700' : success ? 'text-green-700' : 'text-gray-600';
  return (
    <article className={`rounded-lg border bg-white p-4 shadow-sm ${alert ? 'border-red-100' : success ? 'border-green-100' : 'border-gray-200'}`}>
      <div className={`mb-1 flex items-center gap-2 text-sm ${tone}`}><Icon className="h-4 w-4" /><span>{label}</span></div>
      <p className={`text-xl font-bold ${alert ? 'text-red-600' : success ? 'text-green-800' : 'text-gray-900'}`}>{value}</p>
      {note && <p className="text-xs text-gray-500">{note}</p>}
    </article>
  );
}

function ContractDatum({ icon: Icon, label, value, mono = false }: { icon: typeof Calendar; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-gray-400" />
      <div className="min-w-0"><span className="block text-gray-500">{label}</span><span className={`block truncate font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</span></div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof Calendar; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-xs font-semibold uppercase transition-colors sm:px-4 sm:text-sm ${active ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>
      <Icon className="h-4 w-4" />{children}
    </button>
  );
}

function QuotaSchedule({ rows, totalRows, currentPage, pageSize, requiresConnectedHours, moraRate, canPay, expandedQuotaId, detailTab, vouchers, fleetEvidence, onPage, onPageSize, onPay, onToggle, onDetailTab, onUploadVoucher }: {
  rows: MimotoQuota[];
  totalRows: number;
  currentPage: number;
  pageSize: number;
  requiresConnectedHours: boolean;
  moraRate: number;
  canPay: boolean;
  expandedQuotaId: string | null;
  detailTab: QuotaDetailTab;
  vouchers: MimotoQuotaVoucher[];
  fleetEvidence: MimotoFleetEvidence[];
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
  onPay: (row: MimotoQuota) => void;
  onToggle: (row: MimotoQuota) => void;
  onDetailTab: (tab: QuotaDetailTab) => void;
  onUploadVoucher: (row: MimotoQuota, amount: number, currency: MimotoCurrency, file: File) => Promise<boolean>;
}) {
  if (totalRows === 0) return <div className="py-14 text-center text-sm text-gray-500">Aún no hay cuotas generadas.</div>;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1540px] text-sm">
          <thead className="bg-gray-50 text-center text-[11px] font-semibold uppercase text-gray-600">
            <tr>
              <th className="px-3 py-3 text-left">Semana</th><th className="px-3 py-3 text-left">Fecha</th><th className="px-3 py-3">Viajes / bono</th><th className="px-3 py-3">Cuota semanal</th><th className="px-3 py-3 text-green-700">Recaudo por semana</th><th className="px-3 py-3 text-green-700">Cobro saldo</th><th className="px-3 py-3">Cuota a pagar</th><th className="px-3 py-3 text-red-600">Mora ({moraRate.toFixed(2)}%)</th><th className="px-3 py-3 text-orange-600">Pendiente de pago</th><th className="px-3 py-3 text-green-700">Pagado</th><th className="px-3 py-3">Estado</th><th className="px-3 py-3">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <QuotaGroup
                key={row.id}
                row={row}
                requiresConnectedHours={requiresConnectedHours}
                canPay={canPay}
                expanded={expandedQuotaId === row.id}
                detailTab={detailTab}
                vouchers={vouchers.filter((voucher) => voucher.cuota_semanal_id === row.id)}
                fleetEvidence={fleetEvidence.filter((evidence) => evidence.cuota_semanal_id === row.id)}
                onPay={onPay}
                onToggle={onToggle}
                onDetailTab={onDetailTab}
                onUploadVoucher={onUploadVoucher}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-gray-200 p-4"><MimotoPagination page={currentPage} pageSize={pageSize} total={totalRows} onPageChange={onPage} onPageSizeChange={onPageSize} /></div>
    </>
  );
}

function QuotaGroup({ row, requiresConnectedHours, canPay, expanded, detailTab, vouchers, fleetEvidence, onPay, onToggle, onDetailTab, onUploadVoucher }: {
  row: MimotoQuota;
  requiresConnectedHours: boolean;
  canPay: boolean;
  expanded: boolean;
  detailTab: QuotaDetailTab;
  vouchers: MimotoQuotaVoucher[];
  fleetEvidence: MimotoFleetEvidence[];
  onPay: (row: MimotoQuota) => void;
  onToggle: (row: MimotoQuota) => void;
  onDetailTab: (tab: QuotaDetailTab) => void;
  onUploadVoucher: (row: MimotoQuota, amount: number, currency: MimotoCurrency, file: File) => Promise<boolean>;
}) {
  const generatedMora = Number(row.late_fee_total || 0) + Number(row.mora_extra_total || 0);
  const pendingMora = Number(row.saldo_mora || 0) + Number(row.saldo_mora_extra || 0);
  const hasExtraMora = Number(row.saldo_mora_extra || 0) > 0.005;
  const balance = Number(row.saldo_total || 0);
  const revenueDestinations = Array.isArray(row.recaudo_cascada_destino)
    ? row.recaudo_cascada_destino
    : [];
  const storedRevenuePool = Number(row.recaudo_pool || 0);
  const revenuePool = storedRevenuePool > 0.005
    ? storedRevenuePool
    : Number(row.recaudo_aplicado || 0);
  const driverCredit = Number(row.saldo_favor_conductor || 0);
  return (
    <>
      <tr className={`text-center transition-colors hover:bg-gray-50/70 ${expanded ? 'bg-red-50/30' : ''}`}>
        <td className="px-3 py-3 text-left font-semibold text-[#8B1A1A]"><button type="button" onClick={() => onToggle(row)} className="inline-flex items-center gap-2"><ChevronRight className={`h-4 w-4 transition-transform ${expanded ? 'rotate-90' : ''}`} />Semana {row.week_number}</button></td>
        <td className="px-3 py-3 text-left text-gray-600">{formatDateOnly(row.due_date)}</td>
        <td className="px-3 py-3"><p>{row.viajes} viajes · Bono {money(row.bono_moto, row.moneda)}</p>{requiresConnectedHours && <p className="text-xs text-gray-500">{row.horas_conectadas == null ? 'Horas sin dato' : `${Number(row.horas_conectadas)} h conectadas`}</p>}</td>
        <td className="px-3 py-3 font-semibold">{money(row.cuota_semanal, row.moneda)}</td>
        <td className="px-3 py-3 text-green-700">
          <p>{money(revenuePool, row.moneda)}</p>
          <p className="text-xs text-gray-500">{Number(row.pct_recaudo || 0).toFixed(2)}% de {money(row.partner_fees_raw, 'COP')}</p>
          {revenueDestinations.map((destination) => (
            <p key={`${destination.cuota_id}-${destination.monto}`} className="text-xs text-gray-500">
              → {destination.semana ? `Semana ${destination.semana}` : 'Deuda anterior'}: {money(destination.monto, row.moneda)}
            </p>
          ))}
          {Number(row.recaudo_aplicado || 0) > 0.005 && (
            <p className="text-xs text-gray-500">→ Esta semana: {money(row.recaudo_aplicado, row.moneda)}</p>
          )}
          {driverCredit > 0.005 && <p className="text-xs font-semibold">Saldo a favor: {money(driverCredit, row.moneda)}</p>}
        </td>
        <td className="px-3 py-3 text-green-700">{money(row.cobro_saldo, row.moneda)}</td>
        <td className="px-3 py-3"><p className="text-xs text-gray-400">Total: {money(row.amount_due, row.moneda)}</p><p className="font-bold">{money(row.saldo_capital, row.moneda)}</p></td>
        <td className="px-3 py-3"><p className="text-xs text-gray-400">Generada: {money(generatedMora, row.moneda)}</p><p className="font-bold text-red-600">{money(pendingMora, row.moneda)}</p>{hasExtraMora && <span className="mt-1 inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-600">Extra</span>}</td>
        <td className="px-3 py-3 font-semibold text-orange-600">{money(balance, row.moneda)}</td>
        <td className="px-3 py-3 font-semibold text-green-700">{money(row.paid_amount, row.moneda)}</td>
        <td className="px-3 py-3"><MimotoStatusBadge status={row.status} label={MIMOTO_STATUS_LABEL[row.status] || row.status} /></td>
        <td className="px-3 py-3">{balance > 0.005 && <button type="button" disabled={!canPay} onClick={() => onPay(row)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40">Pagar</button>}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12} className="bg-gray-50/80 p-0">
            <QuotaDropdown
              row={row}
              balance={balance}
              tab={detailTab}
              vouchers={vouchers}
              fleetEvidence={fleetEvidence}
              canPay={canPay}
              onTab={onDetailTab}
              onUploadVoucher={onUploadVoucher}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function QuotaDropdown({ row, balance, tab, vouchers, fleetEvidence, canPay, onTab, onUploadVoucher }: {
  row: MimotoQuota;
  balance: number;
  tab: QuotaDetailTab;
  vouchers: MimotoQuotaVoucher[];
  fleetEvidence: MimotoFleetEvidence[];
  canPay: boolean;
  onTab: (tab: QuotaDetailTab) => void;
  onUploadVoucher: (row: MimotoQuota, amount: number, currency: MimotoCurrency, file: File) => Promise<boolean>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState(String(balance));
  const [currency, setCurrency] = useState<MimotoCurrency>(row.moneda);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setAmount(String(balance));
  }, [balance]);

  useEffect(() => {
    if (!file?.type.startsWith('image/')) {
      setPreviewUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const submitVoucher = async () => {
    const parsedAmount = Number(String(amount).replace(',', '.'));
    if (!file || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error(!file ? 'Selecciona una imagen o PDF' : 'Ingresa un monto válido');
      return;
    }
    setUploading(true);
    try {
      const uploaded = await onUploadVoucher(row, parsedAmount, currency, file);
      if (uploaded) {
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    } finally {
      setUploading(false);
    }
  };

  const selectVoucherFile = (selectedFile: File | null) => {
    if (!selectedFile) {
      setFile(null);
      return;
    }
    const allowedType = ['image/jpeg', 'image/png', 'application/pdf'].includes(selectedFile.type)
      || /\.(jpe?g|png|pdf)$/i.test(selectedFile.name);
    if (!allowedType) {
      toast.error('Solo se permiten archivos JPG, PNG o PDF');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (selectedFile.size > 5 * 1024 * 1024) {
      toast.error('El archivo no puede superar 5 MB');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(selectedFile);
  };

  return (
    <div className="border-t border-gray-200 bg-white text-left">
      <div className="flex flex-col gap-2 border-b border-gray-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="font-bold text-gray-900">Semana {row.week_number}</p><p className="text-sm text-gray-500">{formatDateOnly(row.due_date)} · Pendiente {money(balance, row.moneda)}</p></div>
      </div>
      <div className="flex border-b border-gray-200 px-4">
        <button type="button" onClick={() => onTab('comprobantes')} className={`border-b-2 px-4 py-3 text-xs font-semibold uppercase ${tab === 'comprobantes' ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500'}`}>Comprobantes</button>
        <button type="button" onClick={() => onTab('fleet')} className={`border-b-2 px-4 py-3 text-xs font-semibold uppercase ${tab === 'fleet' ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500'}`}>Evidencias Fleet</button>
      </div>
      <div className="p-5">
        {tab === 'comprobantes' ? (
          <div className="space-y-4">
            {balance > 0.005 ? (
              <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                <div className="mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">Comprobante de pago (Yego Mi Moto)</h4>
                  <p className="mt-1 text-xs text-gray-500">Registra el monto y adjunta la imagen o PDF correspondiente a esta cuota.</p>
                </div>

                <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                  <label className="block lg:w-40">
                    <span className="mb-1 block text-xs font-medium text-gray-600">Monto</span>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={amount}
                      disabled={uploading}
                      onChange={(event) => setAmount(event.target.value)}
                      className="h-10 w-full rounded-lg border border-gray-300 px-3 text-sm text-gray-900 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
                    />
                  </label>
                  <label className="block lg:w-40">
                    <span className="mb-1 block text-xs font-medium text-gray-600">Moneda</span>
                    <select
                      value={currency}
                      disabled={uploading}
                      onChange={(event) => setCurrency(event.target.value as MimotoCurrency)}
                      className="h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
                    >
                      <option value="COP">COP ($)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,.jpg,.jpeg,.png,.pdf,application/pdf"
                    className="hidden"
                    onChange={(event) => selectVoucherFile(event.target.files?.[0] || null)}
                  />
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                  >
                    <Upload className="h-4 w-4" />
                    Elegir archivo
                  </button>
                  <button
                    type="button"
                    disabled={!canPay || !file || uploading}
                    onClick={() => void submitVoucher()}
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-[#8B1A1A] px-4 text-sm font-semibold text-white hover:bg-[#731515] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Upload className={`h-4 w-4 ${uploading ? 'animate-pulse' : ''}`} />
                    {uploading ? 'Subiendo...' : 'Subir'}
                  </button>
                </div>

                {file && (
                  <div className="mt-3 flex min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-2.5">
                    {previewUrl ? (
                      <img src={previewUrl} alt="Vista previa del comprobante" className="h-14 w-14 shrink-0 rounded-md border border-gray-200 object-cover" />
                    ) : (
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white">
                        <FileText className="h-6 w-6 text-red-600" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-900" title={file.name}>{file.name}</p>
                      <p className="text-xs text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB · listo para subir</p>
                    </div>
                    <button type="button" disabled={uploading} onClick={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} aria-label="Quitar archivo" className="rounded-lg p-2 text-gray-500 hover:bg-gray-200 disabled:opacity-40"><X className="h-4 w-4" /></button>
                  </div>
                )}

                {!canPay && (
                  <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">La carga permanecerá bloqueada hasta activar el módulo Mi Moto.</p>
                )}
              </section>
            ) : (
              <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">Esta cuota no tiene saldo pendiente.</p>
            )}
            <VoucherList rows={vouchers} />
          </div>
        ) : (
          <FleetEvidenceList rows={fleetEvidence} />
        )}
      </div>
    </div>
  );
}

function VoucherList({ rows }: { rows: MimotoQuotaVoucher[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">No hay comprobantes registrados para esta semana.</p>;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((voucher) => {
        const isImage = Boolean(
          voucher.file_path
          && /\.(jpe?g|png|gif|webp)(?:\?.*)?$/i.test(voucher.file_name || voucher.file_path),
        );
        return (
          <article key={voucher.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-start gap-3">
              {voucher.file_path && isImage ? (
                <img src={voucher.file_path} alt="Comprobante" className="h-14 w-14 shrink-0 rounded-md border border-gray-200 object-cover" />
              ) : (
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-gray-50">
                  <FileText className="h-6 w-6 text-gray-500" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-semibold text-gray-900" title={voucher.file_name || undefined}>{voucher.file_name || 'Comprobante de pago'}</p>
                  <MimotoStatusBadge status={voucher.estado} label={MIMOTO_STATUS_LABEL[voucher.estado] || voucher.estado} />
                </div>
                <p className="mt-1 text-sm font-bold text-green-700">{money(voucher.monto, voucher.moneda)}</p>
                <p className="mt-1 text-xs text-gray-500">{formatDateTimeValue(voucher.created_at)} · {voucher.origen.replace(/_/g, ' ')}</p>
              </div>
            </div>
            {voucher.rechazo_razon && <p className="mt-2 text-xs text-red-700">{voucher.rechazo_razon}</p>}
            {voucher.file_path && (
              <a href={voucher.file_path} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-red-700">
                <ExternalLink className="h-4 w-4" />Ver archivo
              </a>
            )}
          </article>
        );
      })}
    </div>
  );
}

function FleetEvidenceList({ rows }: { rows: MimotoFleetEvidence[] }) {
  if (rows.length === 0) return <p className="text-sm text-gray-500">No hay evidencias Fleet registradas para esta semana.</p>;
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{rows.map((evidence) => <article key={evidence.id} className="rounded-lg border border-gray-200 bg-white p-3"><div className="flex items-center justify-between gap-3"><p className="font-bold text-green-700">{money(evidence.monto, evidence.moneda)}</p><span className={`rounded px-2 py-1 text-xs font-semibold ${evidence.simulated ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800'}`}>{evidence.simulated ? 'Simulada' : 'Confirmada'}</span></div><p className="mt-2 text-xs text-gray-500">{formatDateTimeValue(evidence.created_at)}</p>{evidence.external_reference && <p className="mt-1 truncate text-xs text-gray-600">Ref. {evidence.external_reference}</p>}</article>)}</div>;
}

function formatDateTimeValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

function quotasByRecentWeek(detail: MimotoDetail) {
  return [...detail.cuotas].sort((left, right) => Number(right.week_number) - Number(left.week_number));
}

function buildQuotaWhatsAppMessage(detail: MimotoDetail) {
  const overdue = quotasByRecentWeek(detail).filter((row) => row.status === 'overdue');
  const pending = quotasByRecentWeek(detail).filter((row) => ['pending', 'partial'].includes(row.status));
  const rows = overdue.length > 0 ? overdue : pending.slice(0, 1);
  const lines = rows.slice(0, 10).map((row) => {
    const balance = Number(row.saldo_total || 0);
    return `- Semana ${row.week_number}: ${row.viajes} viajes${row.horas_conectadas == null ? '' : ` · ${Number(row.horas_conectadas)} h`} · Pendiente ${money(balance, row.moneda)}`;
  });
  return [
    `Hola ${detail.first_name} ${detail.last_name},`,
    '',
    overdue.length > 0 ? 'Te compartimos tus cuotas vencidas:' : 'Te compartimos el estado de tu cuota más reciente:',
    ...(lines.length > 0 ? lines : ['No tienes cuotas pendientes.']),
    '',
    'Cualquier consulta quedamos atentos.',
  ].join('\n');
}

function buildMetricsWhatsAppMessage(detail: MimotoDetail) {
  const latest = quotasByRecentWeek(detail)[0];
  if (!latest) return `Hola ${detail.first_name} ${detail.last_name},\n\nAún no hay métricas semanales registradas en Yego Mi Moto.`;
  return [
    `Hola ${detail.first_name} ${detail.last_name},`,
    '',
    `Resumen de la semana ${latest.week_number}:`,
    `- Viajes realizados: ${latest.viajes}`,
    ...(latest.horas_conectadas == null ? [] : [`- Horas conectadas: ${Number(latest.horas_conectadas)} h`]),
    `- Cuota contractual: ${money(latest.cuota_semanal, latest.moneda)}`,
    `- Bono moto: ${money(latest.bono_moto, latest.moneda)}`,
    `- Recaudo aplicado: ${money(latest.recaudo_aplicado, latest.moneda)}`,
    `- Saldo pendiente: ${money(latest.saldo_total, latest.moneda)}`,
    '',
    'Sigue sumando viajes y horas esta semana.',
  ].join('\n');
}

function buildVoucherWhatsAppMessage(detail: MimotoDetail, voucher: MimotoQuotaVoucher | null) {
  if (!voucher) {
    return `Hola ${detail.first_name} ${detail.last_name},\n\nSelecciona un comprobante de pago para compartirlo.`;
  }
  const quota = detail.cuotas.find((row) => row.id === voucher.cuota_semanal_id);
  return [
    `Hola ${detail.first_name} ${detail.last_name},`,
    '',
    'Te compartimos tu comprobante de pago de Yego Mi Moto.',
    `Monto: ${money(voucher.monto, voucher.moneda)}`,
    ...(quota ? [`Cuota: Semana ${quota.week_number}`] : []),
    '',
    'Por favor conserva este archivo como constancia.',
  ].join('\n');
}

function WhatsAppModal({ detail, tab, message, vouchers, selectedVoucher, refreshingPhone, disabled, moduleEnabled, onTab, onVoucher, onRefreshPhone, onMessage, onClose, onSend }: {
  detail: MimotoDetail;
  tab: WhatsAppTab;
  message: string;
  vouchers: MimotoQuotaVoucher[];
  selectedVoucher: MimotoQuotaVoucher | null;
  refreshingPhone: boolean;
  disabled: boolean;
  moduleEnabled: boolean;
  onTab: (tab: WhatsAppTab) => void;
  onVoucher: (voucherId: string) => void;
  onRefreshPhone: () => void;
  onMessage: (message: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const phone = String(detail.phone || '').startsWith('+') ? String(detail.phone) : `+${detail.phone}`;
  const sortedQuotas = quotasByRecentWeek(detail);
  const overdueQuotas = sortedQuotas.filter((row) => row.status === 'overdue');
  const pendingQuotas = sortedQuotas.filter((row) => ['pending', 'partial'].includes(row.status));
  const listedQuotas = overdueQuotas.length > 0 ? overdueQuotas : pendingQuotas.slice(0, 1);
  const latestQuota = sortedQuotas[0] || null;
  const cannotSend = disabled || !message.trim() || !detail.phone
    || (tab === 'comprobante' && !selectedVoucher);
  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <header className="flex items-center justify-between border-b bg-gray-50 px-5 py-4">
          <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#25D366]"><MessageCircle className="h-5 w-5 text-white" /></span><div><h2 className="text-lg font-bold text-gray-900">Enviar por WhatsApp</h2><p className="text-sm text-gray-500">Mensaje individual de Yego Mi Moto</p></div></div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button>
        </header>
        <nav className="flex border-b border-gray-200 px-3">
          {([['cuotas', 'Cuotas'], ['metricas', 'Métricas'], ['comprobante', 'Comprobante de pago']] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => onTab(value)} className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === value ? 'border-[#8B1A1A] text-[#8B1A1A]' : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{label}</button>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <div className="min-w-0"><p className="text-xs font-semibold uppercase text-gray-500">WhatsApp</p><p className="truncate text-sm font-medium text-gray-900">{detail.phone ? phone : 'Sin teléfono'}</p></div>
          <button type="button" onClick={onRefreshPhone} disabled={refreshingPhone} title="Actualizar teléfono desde Fleet" className="inline-flex h-9 items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${refreshingPhone ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
          <div className="overflow-y-auto border-b p-5 lg:border-b-0 lg:border-r">
            <div className="mb-4"><p className="text-xs font-semibold uppercase text-gray-500">Conductor</p><p className="mt-1 font-semibold text-gray-900">{detail.first_name} {detail.last_name}</p><p className="text-sm text-gray-500">{detail.document_type} {detail.document_number} · {detail.fleet_name || 'Flota Colombia'}</p></div>
            {tab === 'cuotas' && (
              <div className="space-y-4">
                <div><p className="text-xs font-semibold uppercase text-gray-500">{overdueQuotas.length > 0 ? 'Cuotas vencidas' : 'Cuota pendiente más reciente'}</p>{listedQuotas.length === 0 ? <p className="mt-2 text-sm text-gray-500">No hay cuotas pendientes.</p> : <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">{listedQuotas.slice(0, 10).map((row) => <article key={row.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3"><div className="flex items-center justify-between gap-3"><p className="font-semibold text-gray-900">Semana {row.week_number}</p><MimotoStatusBadge status={row.status} label={MIMOTO_STATUS_LABEL[row.status] || row.status} /></div><p className="mt-1 text-xs text-gray-500">{formatDateOnly(row.due_date)} · {row.viajes} viajes{row.horas_conectadas == null ? '' : ` · ${Number(row.horas_conectadas)} h`}</p><div className="mt-2 flex items-center justify-between text-sm"><span className="text-gray-500">Pendiente</span><span className="font-bold text-red-700">{money(row.saldo_total, row.moneda)}</span></div></article>)}</div>}</div>
                {latestQuota && <div><p className="text-xs font-semibold uppercase text-gray-500">Recaudo de la semana {latestQuota.week_number}</p><div className="mt-2 space-y-1.5 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm"><SummaryLine label="Viajes" value={String(latestQuota.viajes)} />{latestQuota.horas_conectadas != null && <SummaryLine label="Horas conectadas" value={`${Number(latestQuota.horas_conectadas)} h`} />}<SummaryLine label="Recaudo aplicado" value={money(latestQuota.recaudo_aplicado, latestQuota.moneda)} /><SummaryLine label="Cobro de saldo" value={money(latestQuota.cobro_saldo, latestQuota.moneda)} /></div></div>}
              </div>
            )}
            {tab === 'metricas' && (
              latestQuota ? <div className="space-y-3"><p className="text-xs font-semibold uppercase text-gray-500">Semana {latestQuota.week_number}</p><div className="grid grid-cols-2 gap-3"><MetricValue label="Viajes" value={String(latestQuota.viajes)} /><MetricValue label="Horas" value={latestQuota.horas_conectadas == null ? 'No aplica' : `${Number(latestQuota.horas_conectadas)} h`} /><MetricValue label="Cuota contractual" value={money(latestQuota.cuota_semanal, latestQuota.moneda)} /><MetricValue label="Bono moto" value={money(latestQuota.bono_moto, latestQuota.moneda)} /></div><div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><SummaryLine label="Recaudo aplicado" value={money(latestQuota.recaudo_aplicado, latestQuota.moneda)} /><SummaryLine label="Pagado" value={money(latestQuota.paid_amount, latestQuota.moneda)} /><SummaryLine label="Saldo" value={money(latestQuota.saldo_total, latestQuota.moneda)} /></div></div> : <p className="text-sm text-gray-500">No hay métricas semanales registradas.</p>
            )}
            {tab === 'comprobante' && (
              vouchers.length === 0 ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3"><p className="text-sm font-semibold text-amber-900">No hay comprobantes con archivo.</p><p className="mt-1 text-xs text-amber-700">Primero carga un comprobante dentro del dropdown de una cuota.</p></div> : <div><p className="text-xs font-semibold uppercase text-gray-500">Selecciona el comprobante</p><div className="mt-2 max-h-[360px] space-y-2 overflow-y-auto pr-1">{vouchers.map((voucher) => { const quota = detail.cuotas.find((row) => row.id === voucher.cuota_semanal_id); const selected = selectedVoucher?.id === voucher.id; const isImage = Boolean(voucher.file_path && /\.(jpe?g|png)(?:\?.*)?$/i.test(voucher.file_name || voucher.file_path)); return <button type="button" key={voucher.id} onClick={() => onVoucher(voucher.id)} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left ${selected ? 'border-[#8B1A1A] bg-red-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>{isImage ? <img src={voucher.file_path!} alt="" className="h-12 w-12 shrink-0 rounded-md object-cover" /> : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-gray-100"><FileText className="h-5 w-5 text-red-700" /></span>}<span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-gray-900">{voucher.file_name || 'Comprobante'}</span><span className="block text-xs text-gray-500">{quota ? `Semana ${quota.week_number} · ` : ''}{formatDateTimeValue(voucher.created_at)}</span><span className="mt-1 block text-sm font-bold text-green-700">{money(voucher.monto, voucher.moneda)}</span></span>{selected && <CheckCircle2 className="h-5 w-5 shrink-0 text-[#8B1A1A]" />}</button>; })}</div></div>
            )}
          </div>
          <div className="flex min-h-0 flex-col overflow-y-auto p-5"><label className="text-xs font-semibold uppercase text-gray-500">Mensaje que verá el conductor<textarea rows={18} value={message} onChange={(event) => onMessage(event.target.value)} className="mt-2 w-full resize-y rounded-lg border border-gray-300 p-3 text-sm font-normal leading-5 text-gray-900 focus:border-green-500 focus:ring-2 focus:ring-green-100" /></label>{!moduleEnabled && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">El módulo está en preparación. Puedes revisar el contenido, pero el envío permanece bloqueado.</p>}</div>
        </div>
        <footer className="flex gap-3 border-t bg-gray-50 px-5 py-4"><SecondaryButton onClick={onClose}>Cerrar</SecondaryButton><button type="button" disabled={cannotSend} onClick={onSend} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 text-sm font-semibold text-white hover:bg-[#1fb558] disabled:cursor-not-allowed disabled:bg-gray-300"><Send className="h-4 w-4" />{tab === 'comprobante' ? 'Enviar comprobante' : 'Enviar por WhatsApp'}</button></footer>
      </div>
    </div>,
    document.body,
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-gray-500">{label}</span><span className="font-semibold text-gray-900">{value}</span></div>;
}

function MetricValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs font-semibold uppercase text-gray-500">{label}</p><p className="mt-1 text-lg font-bold text-gray-900">{value}</p></div>;
}

function ExpenseSchedule({ rows, canPay, onPay }: { rows: MimotoExpense[]; canPay: boolean; onPay: (row: MimotoExpense) => void }) {
  if (rows.length === 0) return <div className="py-14 text-center text-sm text-gray-500">No hay otros gastos generados.</div>;
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-sm"><thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-500"><tr><th className="px-4 py-3">Concepto</th><th className="px-4 py-3">Periodo</th><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">Monto</th><th className="px-4 py-3">Pagado</th><th className="px-4 py-3">Pendiente</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Acción</th></tr></thead><tbody className="divide-y divide-gray-100">{rows.map((row) => { const balance = Math.max(0, Number(row.amount_due) - Number(row.paid_amount)); return <tr key={row.id}><td className="px-4 py-3 font-semibold capitalize">{row.tipo.replace(/_/g, ' ')}</td><td className="px-4 py-3">Cuota {row.numero_cuota}/{row.total_cuotas}</td><td className="px-4 py-3">{formatDateOnly(row.due_date)}</td><td className="px-4 py-3">{money(row.amount_due, row.moneda)}</td><td className="px-4 py-3 text-green-700">{money(row.paid_amount, row.moneda)}</td><td className="px-4 py-3 font-semibold text-orange-600">{money(balance, row.moneda)}</td><td className="px-4 py-3"><MimotoStatusBadge status={row.status} label={MIMOTO_STATUS_LABEL[row.status] || row.status} /></td><td className="px-4 py-3">{balance > 0.005 && <button type="button" disabled={!canPay} onClick={() => onPay(row)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-40">Pagar</button>}</td></tr>; })}</tbody></table></div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return createPortal(<div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"><header className="flex items-center justify-between border-b px-5 py-4"><h2 className="text-lg font-bold text-gray-900">{title}</h2><button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"><X className="h-5 w-5" /></button></header><div className="p-5">{children}</div></div></div>, document.body);
}

function FormField({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={`block text-sm font-medium text-gray-700 ${className}`}>{label}{children}</label>;
}

function ModalActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}

function SecondaryButton({ disabled = false, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-medium disabled:opacity-40">{children}</button>;
}

function PrimaryButton({ disabled = false, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" disabled={disabled} onClick={onClick} className="h-10 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white disabled:opacity-40">{children}</button>;
}
