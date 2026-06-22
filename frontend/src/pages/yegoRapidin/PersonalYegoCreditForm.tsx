import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { CheckCircle, ArrowLeft, Loader2, Building2, Upload, X } from 'lucide-react';

interface RRHHUser {
  id: string;
  first_name: string;
  last_name: string;
  dni: string;
  role: string;
}

export default function PersonalYegoCreditForm() {
  const navigate = useNavigate();

  const [users, setUsers] = useState<RRHHUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<RRHHUser | null>(null);
  const [form, setForm] = useState({ amount: '', installments: '12' });
  const [paymentFrequency, setPaymentFrequency] = useState<'semanal' | 'quincenal' | 'mensual'>('mensual');
  const [fechaPrimerCobro, setFechaPrimerCobro] = useState('');
  const [bank, setBank] = useState({ bank: '', accountType: 'ahorros' as 'ahorros' | 'corriente', accountNumber: '' });
  const [bankOther, setBankOther] = useState('');
  const [bankError, setBankError] = useState('');
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docPreviewUrl, setDocPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [config, setConfig] = useState({ interest_rate: 7, max_installments: 10 });

  useEffect(() => {
    let cancelled = false;
    api.get('/creditos-personal-yego/config')
      .then((res: any) => { if (!cancelled && res.data?.data) setConfig(res.data.data); })
      .catch((err: any) => { if (!cancelled) console.error('Config error:', err); });
    return () => { cancelled = true; };
  }, []);

  const doSearch = async (term: string) => {
    if (term.length < 2) {
      setUsers([]);
      setUsersLoading(false);
      return;
    }
    setUsersLoading(true);
    try {
      const res = await api.get(`/creditos-personal-yego/usuarios?q=${encodeURIComponent(term)}`);
      const data = res.data?.data || res.data || [];
      setUsers(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error('Search error:', err);
      toast.error('Error al buscar');
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    doSearch(value.trim());
  };

  const handleSelectUser = (u: RRHHUser) => {
    setSelectedUser(u);
    setSearch('');
    setUsers([]);
    setBankOther('');
    api.get(`/creditos-personal-yego/usuarios/${u.id}/bancarios`)
      .then((res: any) => {
        const b = res.data?.data;
        if (b?.bank_name || b?.bank_account) {
          setBank({ bank: b.bank_name || '', accountType: b.bank_account_type === 'Corriente' ? 'corriente' : 'ahorros', accountNumber: b.bank_account || '' });
        }
      }).catch((err: any) => console.error('Bank error:', err));
  };

  const handleSubmit = async () => {
    if (!selectedUser) { toast.error('Selecciona un colaborador'); return; }
    if (!form.amount) { toast.error('Ingresa el monto'); return; }
    if (!fechaPrimerCobro) { toast.error('Selecciona la fecha de primer cobro'); return; }
    if (bank.bank && bank.accountNumber && bank.bank !== 'OTRO') {
      const digits = bank.accountNumber.replace(/\D/g, '');
      let valid = true;
      let msg = '';
      if (bank.bank === 'BCP' && digits.length !== 13 && digits.length !== 14) { valid = false; msg = 'BCP: 13 o 14 dígitos'; }
      else if (bank.bank === 'BBVA' && digits.length !== 18) { valid = false; msg = 'BBVA: 18 dígitos'; }
      else if (bank.bank === 'INTERBANK' && digits.length !== 13) { valid = false; msg = 'Interbank: 13 dígitos'; }
      if (!valid) { setBankError(msg); toast.error(msg); return; }
    }
    setSubmitting(true);
    try {
      const payload = {
        user_gestion_id: selectedUser.id,
        first_name: selectedUser.first_name,
        last_name: selectedUser.last_name,
        dni: selectedUser.dni,
        role: selectedUser.role,
        amount: parseFloat(form.amount),
        number_of_installments: parseInt(form.installments),
        payment_frequency: paymentFrequency,
        fecha_primer_cobro: fechaPrimerCobro,
        bank_name: bank.bank === 'OTRO' ? bankOther : bank.bank || undefined,
        bank_account: bank.bank !== 'OTRO' ? bank.accountNumber || undefined : undefined,
        bank_account_type: bank.bank !== 'OTRO' ? (bank.accountType === 'ahorros' ? 'Ahorros' : 'Corriente') : undefined,
      };
      const res = await api.post('/creditos-personal-yego', payload);
      const id = res.data?.data?.id;
      if (docFile && id) {
        const fd = new FormData();
        fd.append('file', docFile);
        await api.post(`/creditos-personal-yego/${id}/documentos`, fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }
      toast.success('Crédito personal creado');
      navigate('/admin/loan-requests');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear crédito');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredUsers = search.trim().length >= 2 ? users : [];
  const amount = parseFloat(form.amount) || 0;
  const rateMensual = config.interest_rate;
  const rateEfectiva = paymentFrequency === 'semanal' ? rateMensual / 4 : paymentFrequency === 'quincenal' ? rateMensual / 2 : rateMensual;
  const installments = parseInt(form.installments || '1');
  const totalInterest = amount * rateEfectiva / 100 * installments;
  const totalAmount = amount + totalInterest;
  const cuotaAmount = totalAmount / installments;
  const freqLabel = paymentFrequency === 'semanal' ? 'semana' : paymentFrequency === 'quincenal' ? 'quincena' : 'mes';
  const freqLabelCap = paymentFrequency === 'semanal' ? 'Semanal' : paymentFrequency === 'quincenal' ? 'Quincenal' : 'Mensual';

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="bg-red-800 text-white rounded-lg p-4 flex items-center gap-3">
        <Building2 className="w-10 h-10 flex-shrink-0" />
        <div>
          <h1 className="text-xl font-bold">Crédito Personal de Yego</h1>
          <p className="text-sm text-red-200">{freqLabelCap} · Interés {rateEfectiva.toFixed(2)}% {freqLabel}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-5">
          <div className="bg-white rounded-xl shadow border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-800 mb-3">Buscar colaborador</h3>
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder="Nombre, apellido o DNI..."
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
            </div>
            {usersLoading && (
              <div className="flex items-center gap-2 mt-2 text-sm text-gray-400">
                <Loader2 className="w-4 h-4 animate-spin" /> Buscando...
              </div>
            )}
            {!usersLoading && filteredUsers.length > 0 && (
              <div className="mt-2 border border-gray-200 rounded-lg max-h-52 overflow-y-auto">
                {filteredUsers.slice(0, 20).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => handleSelectUser(u)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-50 border-b border-gray-100 last:border-0 ${selectedUser?.id === u.id ? 'bg-red-50' : ''}`}
                  >
                    <p className="font-medium text-gray-900 text-sm">{u.first_name} {u.last_name}</p>
                    <p className="text-xs text-gray-500">{u.role || 'Sin rol'} · DNI {u.dni}</p>
                  </button>
                ))}
              </div>
            )}
            {selectedUser && (
              <div className="mt-3 bg-red-50 rounded-lg p-3 border border-red-200">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-bold text-gray-900 text-sm">{selectedUser.first_name} {selectedUser.last_name}</p>
                    <p className="text-xs text-gray-600">DNI {selectedUser.dni} · {selectedUser.role}</p>
                  </div>
                  <button onClick={() => { setSelectedUser(null); setDocFile(null); setDocPreviewUrl(null); setForm({ amount: '', installments: '12' }); setBank({ bank: '', accountType: 'ahorros', accountNumber: '' }); setBankOther(''); setBankError(''); setFechaPrimerCobro(''); }} className="text-gray-400 hover:text-red-500"><X className="w-4 h-4" /></button>
                </div>
              </div>
            )}
          </div>

          <div className="bg-white rounded-xl shadow border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-800 mb-3">Condiciones del crédito</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Monto (PEN)</label>
                <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" min="0" step="0.01" className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">N° de cuotas</label>
                <select value={form.installments} onChange={(e) => setForm({ ...form, installments: e.target.value })} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500">
                  {Array.from({ length: config.max_installments }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n} {paymentFrequency === 'semanal' ? (n === 1 ? 'semana' : 'semanas') : paymentFrequency === 'quincenal' ? (n === 1 ? 'quincena' : 'quincenas') : (n === 1 ? 'mes' : 'meses')}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Frecuencia</label>
                <select value={paymentFrequency} onChange={(e) => setPaymentFrequency(e.target.value as 'semanal' | 'quincenal' | 'mensual')} className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500">
                  <option value="semanal">Semanal ({(rateMensual / 4).toFixed(2)}%)</option>
                  <option value="quincenal">Quincenal ({(rateMensual / 2).toFixed(2)}%)</option>
                  <option value="mensual">Mensual ({rateMensual}%)</option>
                </select>
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-xs font-semibold text-gray-500 mb-1">Fecha de primer cobro *</label>
              <input
                type="date"
                value={fechaPrimerCobro}
                onChange={(e) => setFechaPrimerCobro(e.target.value)}
                className="w-full md:w-64 px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500"
              />
              <p className="text-xs text-gray-400 mt-1">La primera cuota vencerá en esta fecha. Las siguientes se calculan según la frecuencia.</p>
            </div>
          </div>

          <div className="bg-white rounded-xl shadow border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-800 mb-3">Cuenta de abono</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Banco</label>
                <select value={bank.bank} onChange={(e) => { setBank({ ...bank, bank: e.target.value }); setBankError(''); }} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500">
                  <option value="">Seleccionar</option><option value="BCP">BCP</option><option value="BBVA">BBVA</option><option value="INTERBANK">Interbank</option><option value="SCOTIABANK">Scotiabank</option><option value="NACION">Banco de la Nación</option><option value="OTRO">Otro</option>
                </select>
              </div>
              {bank.bank === 'OTRO' ? (
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Descripción</label>
                  <input
                    type="text"
                    value={bankOther}
                    onChange={(e) => setBankOther(e.target.value)}
                    placeholder="Escribe acá"
                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500"
                  />
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">Tipo</label>
                    <select value={bank.accountType} onChange={(e) => setBank({ ...bank, accountType: e.target.value as 'ahorros' | 'corriente' })} className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500">
                      <option value="ahorros">Ahorros</option><option value="corriente">Corriente</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-500 mb-1">N° de cuenta</label>
                    <input
                      type="text"
                      value={bank.accountNumber}
                      onChange={(e) => { setBank({ ...bank, accountNumber: e.target.value }); setBankError(''); }}
                      onBlur={() => {
                        if (!bank.bank || !bank.accountNumber || bank.bank === 'OTRO') return;
                        const digits = bank.accountNumber.replace(/\D/g, '');
                        if (bank.bank === 'BCP' && digits.length !== 13 && digits.length !== 14) setBankError('BCP: 13 o 14 dígitos');
                        else if (bank.bank === 'BBVA' && digits.length !== 18) setBankError('BBVA: 18 dígitos');
                        else if (bank.bank === 'INTERBANK' && digits.length !== 13) setBankError('Interbank: 13 dígitos');
                        else setBankError('');
                      }}
                      placeholder="000-000-000"
                      className={`w-full px-3 py-2.5 border rounded-lg text-sm focus:ring-2 focus:ring-red-500 ${bankError ? 'border-red-400' : 'border-gray-300'}`}
                    />
                    {bankError && <p className="text-xs text-red-600 mt-1">{bankError}</p>}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl shadow border border-gray-200 p-5">
            <h3 className="text-sm font-bold text-gray-800 mb-3">Compromiso de pago</h3>
            <p className="text-xs text-gray-400 mb-3">Opcional — puede cargarlo después desde Préstamos</p>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-red-400 text-sm text-gray-600">
                <Upload className="w-4 h-4" />
                {docFile ? docFile.name : 'Seleccionar archivo'}
                <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  setDocFile(f);
                  setDocPreviewUrl(f && f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
                }} className="hidden" />
              </label>
              {docFile && <button onClick={() => { setDocFile(null); setDocPreviewUrl(null); }} className="text-red-500 text-sm">Quitar</button>}
            </div>
            {docPreviewUrl && (
              <div className="mt-3 border rounded-lg overflow-hidden max-w-xs">
                <img src={docPreviewUrl} alt="Vista previa" className="w-full h-auto max-h-40 object-contain" />
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl shadow border border-gray-200 overflow-hidden sticky top-4">
            <div className="bg-red-700 px-5 py-3">
              <h3 className="text-sm font-bold text-white">Resumen del crédito</h3>
            </div>
            <div className="p-5">
              {amount > 0 ? (
                <div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Monto solicitado</span>
                    <span className="text-sm font-semibold text-gray-900">S/ {amount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <div>
                      <span className="text-sm text-gray-500">Tasa de interés</span>
                      <span className="block text-xs text-gray-400">{freqLabelCap} · TNA fija</span>
                    </div>
                    <span className="text-sm text-gray-700">{rateEfectiva.toFixed(2)}% {freqLabel}</span>
                  </div>
                   <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Plazo</span>
                    <span className="text-sm text-gray-700">{installments} {paymentFrequency === 'semanal' ? (installments === 1 ? 'semana' : 'semanas') : paymentFrequency === 'quincenal' ? (installments === 1 ? 'quincena' : 'quincenas') : (installments === 1 ? 'mes' : 'meses')}</span>
                  </div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Primer cobro</span>
                    <span className="text-sm text-gray-700">{fechaPrimerCobro || '—'}</span>
                  </div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Interés por {freqLabel}</span>
                    <span className="text-sm text-gray-700">S/ {(amount * rateEfectiva / 100).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Intereses</span>
                    <span className="text-sm text-gray-700">S/ {totalInterest.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-2.5 border-b border-gray-100">
                    <span className="text-sm text-gray-500">Comisiones</span>
                    <span className="text-sm text-gray-700">S/ 0.00</span>
                  </div>
                  <div className="flex justify-between py-3 border-b border-gray-200">
                    <span className="text-sm font-semibold text-gray-800">Total a pagar</span>
                    <span className="text-base font-bold text-gray-900">S/ {totalAmount.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-center mt-3 pt-3 border-t-2 border-red-600">
                    <span className="text-sm font-bold text-red-700">Cuota {freqLabel}</span>
                    <span className="text-xl font-bold text-red-700">S/ {cuotaAmount.toFixed(2)}</span>
                  </div>
                </div>
              ) : (
                <div className="text-center py-10 text-gray-400">
                  <p className="text-sm">Ingresa el monto para ver el resumen</p>
                </div>
              )}

              {amount > 0 && (
                <div className="flex gap-3 pt-5">
                  <button type="button" onClick={() => navigate('/admin/loan-requests/credit-type')} className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 text-sm">
                    <ArrowLeft className="w-4 h-4" /> Volver
                  </button>
                  <button type="button" onClick={handleSubmit} disabled={!selectedUser || !fechaPrimerCobro || submitting} className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 font-medium text-sm">
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                    {submitting ? 'Creando...' : 'Crear Crédito'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
