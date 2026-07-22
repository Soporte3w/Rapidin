import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, Bike, Check, ChevronLeft, ChevronRight, ClipboardCheck, FileText, Save, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../services/api';
import { fetchMimotoCronogramas, fetchMimotoFleets, formatMimotoMoney, mimotoApiErrorMessage, type MimotoCronograma, type MimotoFleet, unwrap } from './mimotoApi';
import { MimotoPageHeader } from './mimotoUi';

const INITIAL = {
  fleet_id: '', document_type: 'CC', document_number: '', first_name: '', last_name: '', phone: '', email: '', license_number: '',
  driver_id_fleet: '', cronograma_id: '', cronograma_vehiculo_id: '', pago_tipo: 'completo',
  fecha_inicio_cobro_semanal: '', fecha_entrega_vehiculo: '', placa_asignada: '', observations: '',
};

const STEPS = [
  { label: 'Conductor', icon: UserRound },
  { label: 'Plan y moto', icon: Bike },
  { label: 'Revisar', icon: ClipboardCheck },
];

const INPUT_CLASS = 'mt-1.5 h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100';

export default function YegoMiMotoNewRequest() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(INITIAL);
  const [fleets, setFleets] = useState<MimotoFleet[]>([]);
  const [cronogramas, setCronogramas] = useState<MimotoCronograma[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchMimotoFleets(true).then(setFleets).catch(() => toast.error('No se pudieron cargar las flotas')); }, []);
  useEffect(() => {
    fetchMimotoCronogramas().then(setCronogramas).catch(() => toast.error('No se pudieron cargar los cronogramas'));
  }, []);

  const selectedCronograma = useMemo(() => cronogramas.find((item) => item.id === form.cronograma_id), [cronogramas, form.cronograma_id]);
  const selectedVehicle = useMemo(() => selectedCronograma?.vehiculos.find((item) => item.id === form.cronograma_vehiculo_id), [form.cronograma_vehiculo_id, selectedCronograma]);
  const selectedFleet = fleets.find((item) => item.id === form.fleet_id);
  const change = (field: keyof typeof INITIAL, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const allowedInitialTypes = selectedCronograma?.requisitos_vehiculo?.modalidades_pago_inicial;
  useEffect(() => {
    if (!allowedInitialTypes) return;
    setForm((current) => {
      if (current.pago_tipo === 'completo' && allowedInitialTypes.completo === false) {
        return { ...current, pago_tipo: 'parcial' };
      }
      if (current.pago_tipo === 'parcial' && allowedInitialTypes.parcial === false) {
        return { ...current, pago_tipo: 'completo' };
      }
      return current;
    });
  }, [allowedInitialTypes]);

  const validateStep = () => {
    if (step === 0 && (!form.fleet_id || !form.document_number.trim() || !form.first_name.trim() || !form.last_name.trim() || !form.phone.trim())) return 'Completa los datos obligatorios del conductor';
    if (step === 1 && (!form.cronograma_id || !form.cronograma_vehiculo_id)) return 'Selecciona el cronograma y la moto';
    return null;
  };

  const next = () => {
    const error = validateStep();
    if (error) return toast.error(error);
    setStep((value) => Math.min(2, value + 1));
  };

  const submit = async () => {
    setSaving(true);
    try {
      const response = await api.post('/mimoto/solicitudes', form);
      const created = unwrap<{ id: string }>(response);
      toast.success('Solicitud Mi Moto creada');
      navigate(`/admin/yego-mi-moto/requests/${created.id}`);
    } catch (error: unknown) {
      toast.error(mimotoApiErrorMessage(error, 'No se pudo crear la solicitud'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 lg:space-y-6">
      <MimotoPageHeader icon={Bike} title="Nueva solicitud Mi Moto" subtitle="Registro de conductor, plan y moto para Colombia" action={<button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-2 rounded-lg bg-white/20 px-4 py-2.5 font-medium text-white hover:bg-white/30"><ArrowLeft className="h-4 w-4" />Volver</button>} />

      <nav className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm" aria-label="Progreso de la solicitud"><ol className="grid grid-cols-3 gap-2">{STEPS.map(({ label, icon: Icon }, index) => <li key={label}><button type="button" onClick={() => index < step && setStep(index)} className={`flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2.5 text-xs font-semibold transition sm:text-sm ${index === step ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : index < step ? 'text-green-700 hover:bg-green-50' : 'text-gray-400'}`}>{index < step ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}<span className="hidden sm:inline">{label}</span><span className="sm:hidden">{index + 1}</span></button></li>)}</ol></nav>

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
        {step === 0 && <div className="space-y-5"><div><h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><UserRound className="h-5 w-5 text-red-700" />Conductor y flota</h2><p className="mt-1 text-sm text-gray-500">Identificación colombiana y vínculo con Fleet</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Flota *"><select required value={form.fleet_id} onChange={(event) => change('fleet_id', event.target.value)} className={INPUT_CLASS}><option value="">Seleccionar</option>{fleets.map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name}</option>)}</select></Field>
          <Field label="Tipo de documento *"><select value={form.document_type} onChange={(event) => change('document_type', event.target.value)} className={INPUT_CLASS}><option value="CC">Cédula de ciudadanía</option><option value="CE">Cédula de extranjería</option><option value="PPT">PPT</option></select></Field>
          <Field label="Número de documento *"><input value={form.document_number} onChange={(event) => change('document_number', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="Nombres *"><input value={form.first_name} onChange={(event) => change('first_name', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="Apellidos *"><input value={form.last_name} onChange={(event) => change('last_name', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="Celular colombiano *"><input value={form.phone} onChange={(event) => change('phone', event.target.value)} placeholder="3001234567" className={INPUT_CLASS} /></Field>
          <Field label="Correo"><input type="email" value={form.email} onChange={(event) => change('email', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="Licencia"><input value={form.license_number} onChange={(event) => change('license_number', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="ID conductor Fleet"><input value={form.driver_id_fleet} onChange={(event) => change('driver_id_fleet', event.target.value)} className={INPUT_CLASS} /></Field>
        </div></div>}

        {step === 1 && <div className="space-y-5"><div><h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><Bike className="h-5 w-5 text-red-700" />Plan y moto</h2><p className="mt-1 text-sm text-gray-500">Condiciones financieras y fechas del contrato</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Cronograma *"><select value={form.cronograma_id} onChange={(event) => { change('cronograma_id', event.target.value); change('cronograma_vehiculo_id', ''); }} className={INPUT_CLASS}><option value="">Seleccionar</option>{cronogramas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Moto *"><select value={form.cronograma_vehiculo_id} onChange={(event) => change('cronograma_vehiculo_id', event.target.value)} className={INPUT_CLASS}><option value="">Seleccionar</option>{(selectedCronograma?.vehiculos || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Modalidad inicial"><select value={form.pago_tipo} onChange={(event) => change('pago_tipo', event.target.value)} className={INPUT_CLASS}>{allowedInitialTypes?.completo !== false && <option value="completo">Inicial completa</option>}{allowedInitialTypes?.parcial !== false && <option value="parcial">Inicial parcial</option>}</select></Field>
          <Field label="Placa de la moto"><input value={form.placa_asignada} onChange={(event) => change('placa_asignada', event.target.value.toUpperCase())} className={INPUT_CLASS} /></Field>
          <Field label="Entrega de moto"><input type="date" value={form.fecha_entrega_vehiculo} onChange={(event) => change('fecha_entrega_vehiculo', event.target.value)} className={INPUT_CLASS} /></Field>
          <Field label="Inicio de cobro semanal"><input type="date" value={form.fecha_inicio_cobro_semanal} onChange={(event) => change('fecha_inicio_cobro_semanal', event.target.value)} className={INPUT_CLASS} /></Field>
        </div>{selectedVehicle && <div className="flex items-center gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4">{selectedVehicle.metadata?.image ? <img src={selectedVehicle.metadata.image} alt={selectedVehicle.name} className="h-20 w-20 rounded-lg object-cover" /> : <div className="grid h-20 w-20 place-items-center rounded-lg border-2 border-dashed border-gray-200 bg-white"><Bike className="h-7 w-7 text-gray-300" /></div>}<div><p className="font-bold text-gray-900">{selectedVehicle.name}</p><p className="mt-1 text-sm text-gray-500">{selectedVehicle.cuotas_semanales} cuotas · Inicial {formatMimotoMoney(selectedVehicle.inicial, selectedVehicle.inicial_moneda)}</p></div></div>}<Field label="Observaciones"><textarea value={form.observations} onChange={(event) => change('observations', event.target.value)} rows={3} className="mt-1.5 w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-red-500 focus:ring-2 focus:ring-red-100" /></Field></div>}

        {step === 2 && <div className="space-y-5"><div><h2 className="flex items-center gap-2 text-base font-bold text-gray-900"><ClipboardCheck className="h-5 w-5 text-red-700" />Revisar solicitud</h2><p className="mt-1 text-sm text-gray-500">Confirma los datos antes de crear el registro</p></div><div className="grid gap-4 md:grid-cols-2"><Review title="Conductor" icon={UserRound} rows={[[`${form.first_name} ${form.last_name}`, `${form.document_type} ${form.document_number}`], ['Celular', `+57 ${form.phone}`], ['Flota', selectedFleet?.name || '—'], ['Licencia', form.license_number || '—']]} /><Review title="Contrato" icon={FileText} rows={[[selectedCronograma?.name || 'Sin cronograma', selectedVehicle?.name || 'Sin moto'], ['Modalidad', form.pago_tipo === 'parcial' ? 'Inicial parcial' : 'Inicial completa'], ['Placa', form.placa_asignada || 'Sin placa'], ['Inicio de cobro', form.fecha_inicio_cobro_semanal || 'Por definir']]} /></div></div>}
      </section>

      <footer className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0} className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:invisible"><ChevronLeft className="h-4 w-4" />Anterior</button>{step < 2 ? <button type="button" onClick={next} className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700">Siguiente<ChevronRight className="h-4 w-4" /></button> : <button type="button" disabled={saving} onClick={() => void submit()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-red-600 px-5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"><Save className="h-4 w-4" />{saving ? 'Guardando...' : 'Crear solicitud'}</button>}</footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium text-gray-700">{label}{children}</label>; }

function Review({ title, icon: Icon, rows }: { title: string; icon: typeof UserRound; rows: Array<[string, string]> }) { return <section className="rounded-lg border border-gray-200 p-4"><h3 className="flex items-center gap-2 font-bold text-gray-900"><Icon className="h-4 w-4 text-red-700" />{title}</h3><dl className="mt-4 space-y-3">{rows.map(([label, value], index) => <div key={`${label}-${index}`}><dt className="text-xs font-semibold uppercase text-gray-400">{label}</dt><dd className="mt-0.5 text-sm font-medium text-gray-800">{value}</dd></div>)}</dl></section>; }
