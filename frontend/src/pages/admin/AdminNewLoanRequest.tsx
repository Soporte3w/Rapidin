import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  CheckCircle, ArrowLeft, ArrowRight, User, CreditCard, FileText, Users,
  Calendar, FileCheck, Camera, Loader2, DollarSign, ChevronDown
} from 'lucide-react';
import { formatCurrency, getCurrencyLabel } from '../../utils/currency';

const STEPS = [
  { number: 1, name: 'Solicitante', icon: User },
  { number: 2, name: 'Datos Bancarios', icon: CreditCard },
  { number: 3, name: 'Solicitud', icon: FileText },
  { number: 4, name: 'Contacto / Garante', icon: Users },
  { number: 5, name: 'Cuoteo', icon: Calendar },
  { number: 6, name: 'Términos', icon: FileCheck },
  { number: 7, name: 'Firma y Documento', icon: Camera },
];

function validateBankAccount(bank: string, accountNumber: string): { valid: boolean; message?: string } {
  const digits = accountNumber.replace(/\D/g, '');
  if (!digits.length) return { valid: false, message: 'Ingresa el número de cuenta' };
  if (bank === 'BCP' && digits.length !== 13 && digits.length !== 14) return { valid: false, message: 'BCP: 13 o 14 dígitos' };
  if (bank === 'BBVA' && digits.length !== 18) return { valid: false, message: 'BBVA: 18 dígitos' };
  if (bank === 'INTERBANK' && digits.length !== 13) return { valid: false, message: 'Interbank: 13 dígitos' };
  return { valid: true };
}

export default function AdminNewLoanRequest() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [offer, setOffer] = useState<{ cycle: number; maxAmount: number; requiresGuarantor: boolean } | null>(null);
  const [loanOptions, setLoanOptions] = useState<any>(null);
  const signatureRef = useRef<HTMLCanvasElement>(null);
  const contactSignatureRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const isSubmittingRef = useRef(false);

  const [beneficiary, setBeneficiary] = useState({
    first_name: '',
    last_name: '',
    dni: '',
    phone: '',
    country: '' as '' | 'PE' | 'CO',
    email: '',
  });
  const [nameSearchQuery, setNameSearchQuery] = useState('');
  const [nameSearchResults, setNameSearchResults] = useState<Array<{ id: string; conductor_id?: string; source?: string; first_name: string; last_name: string; dni: string; document_type?: string; phone: string; email: string; country: string; country_label?: string; flota: { park_id: string | null; flota_name: string; has_active_loan?: boolean } }>>([]);
  const [nameSearchLoading, setNameSearchLoading] = useState(false);
  const [showNameDropdown, setShowNameDropdown] = useState(false);
  const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
  const [hasSelectedConductor, setHasSelectedConductor] = useState(false);
  const [selectedParkIdForLoan, setSelectedParkIdForLoan] = useState<string | null>(null);
  const [documentTypeForInput, setDocumentTypeForInput] = useState<'PE' | 'CO'>('PE');
  const [contactDniLoading, setContactDniLoading] = useState(false);
  const nameSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameSearchContainerRef = useRef<HTMLDivElement>(null);
  const contactDniDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [formData, setFormData] = useState({
    depositType: 'yango' as 'yango' | 'bank',
    bank: '',
    accountType: '',
    accountNumber: '',
    bankAccountInputType: '' as '' | 'ahorros' | 'cci',
    savingsAccountOrCci: '',
    requestedAmount: '',
    purpose: '',
    contactName: '',
    contactDni: '',
    contactPhone: '',
    contactRelationship: '',
    contactSignature: '',
    contactFrontPhoto: null as File | null,
    selectedOption: null as number | null,
    termsAccepted: false,
    contractSignature: '',
    idDocument: null as File | null,
  });

  useEffect(() => {
    if (currentStep === 7 && signatureRef.current) {
      const ctx = signatureRef.current.getContext('2d');
      if (ctx) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
    }
    if (currentStep === 4 && contactSignatureRef.current) {
      const ctx = contactSignatureRef.current.getContext('2d');
      if (ctx) {
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
    }
  }, [currentStep]);

  useEffect(() => {
    if (beneficiary.country && currentStep >= 2) {
      api.get(`/admin/loan-offer?country=${beneficiary.country}`)
        .then((r) => setOffer(r.data.data))
        .catch(() => setOffer(null));
    }
  }, [beneficiary.country, currentStep]);

  useEffect(() => {
    if (nameSearchQuery.trim().length < 2) {
      setNameSearchResults([]);
      setShowNameDropdown(false);
      return;
    }
    if (nameSearchDebounceRef.current) clearTimeout(nameSearchDebounceRef.current);
    nameSearchDebounceRef.current = setTimeout(() => {
      setNameSearchLoading(true);
      const params = new URLSearchParams({ q: nameSearchQuery.trim() });
      if (beneficiary.country) params.set('country', beneficiary.country);
      api.get(`/admin/driver-search?${params.toString()}`)
        .then((res) => {
          const list = res.data?.data ?? [];
          setNameSearchResults(Array.isArray(list) ? list : []);
          setShowNameDropdown(true);
        })
        .catch(() => setNameSearchResults([]))
        .finally(() => setNameSearchLoading(false));
    }, 300);
    return () => {
      if (nameSearchDebounceRef.current) clearTimeout(nameSearchDebounceRef.current);
    };
  }, [nameSearchQuery, beneficiary.country]);

  useEffect(() => {
    const closeDropdown = (e: MouseEvent) => {
      if (nameSearchContainerRef.current && !nameSearchContainerRef.current.contains(e.target as Node)) {
        setShowNameDropdown(false);
      }
    };
    if (showNameDropdown) {
      document.addEventListener('mousedown', closeDropdown);
      return () => document.removeEventListener('mousedown', closeDropdown);
    }
  }, [showNameDropdown]);

  /** Elegir conductor y flota desde la lista (cada ítem = conductor + flota). */
  const selectDriverAndFlota = (
    driver: { id: string; conductor_id?: string; first_name: string; last_name: string; dni: string; phone: string; country: string; email?: string; document_type?: string },
    flota: { park_id: string | null; flota_name: string; has_active_loan?: boolean }
  ) => {
    // El admin puede crear otra solicitud aunque el conductor tenga préstamo activo en esta flota (solo la vista admin).
    setSelectedDriverId(driver.conductor_id ?? driver.id);
    setBeneficiary({
      first_name: driver.first_name,
      last_name: driver.last_name,
      dni: driver.dni,
      phone: driver.phone,
      country: driver.country as 'PE' | 'CO',
      email: driver.email || ''
    });
    setSelectedParkIdForLoan(flota.park_id ?? null);
    setHasSelectedConductor(true);
    setNameSearchQuery('');
    setNameSearchResults([]);
    setShowNameDropdown(false);
    toast.success('Datos cargados');
  };

  const lookupContactDni = async (dni: string) => {
    if (dni.length !== 8) return;
    setContactDniLoading(true);
    try {
      const res = await api.get(`/admin/dni-info?dni=${dni}`);
      const data = res.data?.data;
      if (data?.fullName) {
        setFormData((p) => ({ ...p, contactName: data.fullName }));
        toast.success('Nombre obtenido');
      }
    } catch {
      // No mostrar error, el usuario puede ingresar manualmente
    } finally {
      setContactDniLoading(false);
    }
  };

  useEffect(() => {
    if (currentStep === 5 && formData.requestedAmount && beneficiary.country) {
      setLoading(true);
      api.post('/admin/loan-simulate', {
        country: beneficiary.country,
        requested_amount: formData.requestedAmount,
        cycle: offer?.cycle ?? 1,
      })
        .then((res) => setLoanOptions(res.data.data))
        .catch(() => toast.error('Error al cargar opciones'))
        .finally(() => setLoading(false));
    }
  }, [currentStep, formData.requestedAmount, beneficiary.country, offer?.cycle]);

  const getCanvasCoords = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };
  const handleSigStart = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>, contact = false) => {
    if ('touches' in e) e.preventDefault();
    const canvas = contact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const { x, y } = getCanvasCoords(canvas, clientX, clientY);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(x, y);
    setIsDrawing(true);
  };
  const handleSigMove = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>, contact = false) => {
    if (!isDrawing) return;
    if ('touches' in e) e.preventDefault();
    const canvas = contact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const { x, y } = getCanvasCoords(canvas, clientX, clientY);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const handleSigEnd = (contact = false) => {
    setIsDrawing(false);
    const canvas = contact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hasContent = imageData.data.some((_, i) => i % 4 === 3 && imageData.data[i] > 0);
    if (hasContent) {
      const dataURL = canvas.toDataURL();
      if (contact) setFormData((p) => ({ ...p, contactSignature: dataURL }));
      else setFormData((p) => ({ ...p, contractSignature: dataURL }));
    }
  };
  const clearSig = (contact = false) => {
    const canvas = contact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (contact) setFormData((p) => ({ ...p, contactSignature: '' }));
    else setFormData((p) => ({ ...p, contractSignature: '' }));
  };
  const hasCanvasContent = (canvas: HTMLCanvasElement | null): boolean => {
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  };

  const validateStep = (step: number): boolean => {
    if (step === 1) {
      if (!hasSelectedConductor || !selectedDriverId) {
        toast.error('Selecciona un conductor en Buscar por nombre.');
        return false;
      }
      if (!beneficiary.country || (beneficiary.country !== 'PE' && beneficiary.country !== 'CO')) {
        toast.error('Selecciona Trabaja en (Perú o Colombia).');
        return false;
      }
      if (!beneficiary.first_name?.trim() || !beneficiary.last_name?.trim()) {
        toast.error('Nombre y apellido son requeridos.');
        return false;
      }
      const dniLen = documentTypeForInput === 'PE' ? 8 : 10;
      if (beneficiary.dni.replace(/\D/g, '').length !== dniLen) {
        toast.error(documentTypeForInput === 'PE' ? 'DNI debe tener 8 dígitos' : 'Cédula debe tener 10 dígitos');
        return false;
      }
      return true;
    }
    if (step === 2) {
      if (formData.depositType === 'bank') {
        if (!formData.bank) {
          toast.error('Selecciona el banco');
          return false;
        }
        if (!formData.bankAccountInputType) {
          toast.error('Elige tipo: Cuenta de ahorro o CCI');
          return false;
        }
        if (formData.bankAccountInputType === 'ahorros') {
          if (!formData.accountNumber) {
            toast.error('Ingresa el número de cuenta de ahorro');
            return false;
          }
          const v = validateBankAccount(formData.bank, formData.accountNumber);
          if (!v.valid) {
            toast.error(v.message ?? 'Número de cuenta inválido');
            return false;
          }
        } else {
          if ((formData.savingsAccountOrCci || '').replace(/\D/g, '').length !== 20) {
            toast.error('El CCI debe tener 20 dígitos');
            return false;
          }
        }
      }
      return true;
    }
    if (step === 3) {
      const amount = parseFloat(formData.requestedAmount);
      if (!formData.requestedAmount || !formData.purpose || isNaN(amount) || amount < 1) {
        toast.error('Monto y propósito son requeridos');
        return false;
      }
      return true;
    }
    if (step === 4) {
      const phoneDigits = (formData.contactPhone || '').replace(/\D/g, '');
      if (offer?.requiresGuarantor) {
        if (!formData.contactName?.trim() || !formData.contactDni?.trim() || !formData.contactFrontPhoto) {
          toast.error('Completa datos y foto DNI del garante');
          return false;
        }
        if (!formData.contactSignature && !hasCanvasContent(contactSignatureRef.current)) {
          toast.error('Firma del garante requerida');
          return false;
        }
      } else {
        if (!formData.contactName?.trim() || !formData.contactDni?.trim() || !formData.contactPhone?.trim()) {
          toast.error('Completa datos de la persona de contacto');
          return false;
        }
      }
      if (phoneDigits.length < 9) {
        toast.error('Teléfono de contacto con al menos 9 dígitos');
        return false;
      }
      if (formData.contactDni?.trim() === beneficiary.dni?.trim()) {
        toast.error('El documento del contacto no puede ser el mismo que el del solicitante');
        return false;
      }
      return true;
    }
    if (step === 5) {
      if (formData.selectedOption === null) {
        toast.error('Selecciona un plan de pago');
        return false;
      }
      return true;
    }
    if (step === 6) {
      if (!formData.termsAccepted) {
        toast.error('Acepta los términos y condiciones');
        return false;
      }
      return true;
    }
    if (step === 7) {
      const hasSig = !!formData.contractSignature || hasCanvasContent(signatureRef.current);
      if (!hasSig) {
        toast.error('Debes firmar el contrato');
        return false;
      }
      if (!formData.idDocument) {
        toast.error('Sube una foto del DNI del solicitante');
        return false;
      }
      return true;
    }
    return true;
  };

  const handleNext = async () => {
    if (currentStep === 1 && hasSelectedConductor && !selectedParkIdForLoan) {
      toast.error('Selecciona la flota desde la búsqueda (elige un ítem conductor + flota).');
      return;
    }
    if (!validateStep(currentStep)) return;
    // No se guarda el conductor en rapidin_drivers hasta enviar la solicitud completa (handleSubmit).
    // Así, si el admin se equivoca de conductor o abandona el flujo, no queda creado "por las puras".
    if (currentStep < 7) setCurrentStep(currentStep + 1);
    else handleSubmit();
  };

  const base64ToFile = (dataUrl: string, filename: string): File | null => {
    try {
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const bytes = atob(base64);
      const u8 = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) u8[i] = bytes.charCodeAt(i);
      return new File([new Blob([u8], { type: 'image/png' })], filename, { type: 'image/png' });
    } catch {
      return null;
    }
  };

  const handleSubmit = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    try {
      const contractSig = formData.contractSignature || (signatureRef.current && hasCanvasContent(signatureRef.current) ? signatureRef.current.toDataURL('image/png') : '');
      const contactSig = formData.contactSignature || (contactSignatureRef.current && hasCanvasContent(contactSignatureRef.current) ? contactSignatureRef.current.toDataURL('image/png') : '');

      const fd = new FormData();
      const fields: Record<string, string> = {
        first_name: beneficiary.first_name.trim(),
        last_name: beneficiary.last_name.trim(),
        dni: beneficiary.dni.trim(),
        phone: beneficiary.phone.trim(),
        country: beneficiary.country,
        email: beneficiary.email.trim(),
        requested_amount: formData.requestedAmount,
        purpose: formData.purpose.trim(),
        deposit_type: formData.depositType,
        contact_name: formData.contactName.trim(),
        contact_dni: formData.contactDni.trim(),
        contact_phone: formData.contactPhone.trim(),
        contact_relationship: formData.contactRelationship.trim(),
        selected_option: String(formData.selectedOption ?? ''),
        ...(formData.depositType === 'bank' && {
          bank: formData.bank,
          account_type: formData.accountType || 'CUENTA DE AHORRO',
          account_number: formData.bankAccountInputType === 'ahorros' ? formData.accountNumber : '',
          bank_account_input_type: formData.bankAccountInputType,
          savings_account_cci: formData.bankAccountInputType === 'cci' ? formData.savingsAccountOrCci.trim() : '',
        }),
      };
      Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
      if (selectedParkIdForLoan) fd.append('park_id', selectedParkIdForLoan);
      // driver_id del conductor seleccionado en la búsqueda (Yego): se guarda como external_driver_id en rapidin_drivers
      if (selectedDriverId && selectedDriverId.startsWith('driver-')) {
        fd.append('external_driver_id', selectedDriverId.slice(7));
      }

      if (contactSig) fd.append('contact_signature', contactSig);
      if (formData.contactFrontPhoto) fd.append('contact_front_photo', formData.contactFrontPhoto);
      if (contractSig) {
        const file = base64ToFile(contractSig, 'contract-signature.png');
        fd.append('contract_signature', file ?? contractSig);
      }
      if (formData.idDocument) fd.append('id_document', formData.idDocument);

      await api.post('/admin/loan-request', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Solicitud creada correctamente');
      navigate('/admin/loan-requests');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Error al crear la solicitud');
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
    }
  };

  const renderStep = () => {
    if (currentStep === 1) {
      const requiredDniLen = documentTypeForInput === 'PE' ? 8 : 10;
      const isLocked = !hasSelectedConductor;
      return (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">A quien le solicita el crédito</h2>
          <p className="text-sm text-gray-600">Busca por nombre para cargar los datos del solicitante.</p>
          {/* Buscar por nombre: solo en una fila */}
          <div className="relative" ref={nameSearchContainerRef}>
            <label className="block text-sm font-medium text-gray-700 mb-1">Buscar por nombre</label>
            <div
              className={`flex items-center gap-1 w-full bg-white border overflow-hidden transition-colors ${
                showNameDropdown && nameSearchResults.length > 0
                  ? 'border-red-500 ring-2 ring-red-200 rounded-t-lg'
                  : 'border-gray-300 rounded-lg focus-within:ring-2 focus-within:ring-red-500 focus-within:border-red-500'
              }`}
            >
              <input
                type="text"
                value={nameSearchQuery}
                onChange={(e) => {
                  const v = e.target.value;
                  setNameSearchQuery(v);
                  setBeneficiary({ first_name: '', last_name: '', dni: '', phone: '', email: '', country: '' });
                  setHasSelectedConductor(false);
                  setSelectedDriverId(null);
                  setSelectedParkIdForLoan(null);
                  setDocumentTypeForInput('PE');
                  if (!v.trim()) {
                    setNameSearchResults([]);
                    setShowNameDropdown(false);
                  }
                }}
                onFocus={() => nameSearchResults.length > 0 && setShowNameDropdown(true)}
                placeholder="Escribe nombre o apellido del conductor..."
                className="flex-1 min-w-0 px-3 py-2.5 border-0 focus:ring-0 focus:outline-none rounded-l-lg"
              />
              <span className="flex items-center pr-2 text-gray-400 pointer-events-none">
                {nameSearchLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <ChevronDown className={`w-5 h-5 transition-transform ${showNameDropdown && nameSearchResults.length > 0 ? 'rotate-180' : ''}`} />
                )}
              </span>
            </div>
            {showNameDropdown && nameSearchResults.length > 0 && (
              <div className="absolute z-10 w-full border border-t-0 border-red-500 rounded-b-lg shadow-lg bg-white max-h-60 overflow-y-auto ring-2 ring-red-200 ring-t-0">
                <ul className="py-1">
                  {nameSearchResults.map((d) => {
                    const isThisSelected = hasSelectedConductor && selectedDriverId === (d.conductor_id ?? d.id) && (selectedParkIdForLoan || null) === (d.flota.park_id ?? null);
                    return (
                      <li key={d.id} className="border-b border-gray-100 last:border-0">
                        <button
                          type="button"
                          onClick={() => selectDriverAndFlota(d, d.flota)}
                          className={`w-full text-left px-4 py-2.5 flex flex-col gap-0.5 transition-colors ${
                            isThisSelected
                                ? 'bg-red-50 ring-1 ring-inset ring-red-200'
                                : 'hover:bg-red-50'
                          }`}
                          title={`Seleccionar ${d.first_name} ${d.last_name} - ${(d.flota.flota_name || '').replace(/\bYego\s*/gi, '').trim() || d.flota.flota_name}`}
                        >
                          <span className="font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                            {d.first_name} {d.last_name}
                            <span className="text-red-600 font-normal">· {(d.flota.flota_name || '').replace(/\bYego\s*/gi, '').trim() || d.flota.flota_name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${d.country === 'CO' ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800'}`}>
                              {d.country}
                            </span>
                            {isThisSelected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-medium">Seleccionado</span>}
                          </span>
                          <span className="text-xs text-gray-500">{d.document_type || 'Doc'} {d.dni || '—'} {d.phone ? ` · ${d.phone}` : ''}</span>
                          {d.flota.has_active_loan && <span className="text-xs text-amber-700 font-medium">Préstamo activo en esta flota</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Trabaja en</label>
              <select
                value={beneficiary.country}
                onChange={(e) => setBeneficiary((b) => ({ ...b, country: e.target.value as '' | 'PE' | 'CO' }))}
                disabled={hasSelectedConductor}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 ${hasSelectedConductor ? 'border-gray-200 bg-gray-100 text-gray-600 cursor-not-allowed' : 'border-gray-300'}`}
              >
                <option value="">Seleccione...</option>
                <option value="PE">Perú</option>
                <option value="CO">Colombia</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Documento <span className="text-red-600">*</span></label>
              <div className={`flex gap-0 border overflow-hidden rounded-lg ${hasSelectedConductor ? 'border-gray-300 focus-within:ring-2 focus-within:ring-red-500 focus-within:border-red-500' : 'border-gray-200 bg-gray-100'}`}>
                <select
                  value={documentTypeForInput}
                  onChange={(e) => setDocumentTypeForInput(e.target.value as 'PE' | 'CO')}
                  disabled={isLocked}
                  className={`min-w-[100px] px-3 py-2 border-0 border-r border-gray-200 bg-gray-50 text-gray-700 text-sm focus:ring-0 focus:outline-none ${isLocked ? 'cursor-not-allowed opacity-70' : ''}`}
                >
                  <option value="PE">DNI</option>
                  <option value="CO">Cédula</option>
                </select>
                <input
                  type="text"
                  inputMode="numeric"
                  value={beneficiary.dni}
                  disabled={isLocked}
                  onChange={(e) => setBeneficiary((b) => ({ ...b, dni: e.target.value.replace(/\D/g, '').slice(0, requiredDniLen) }))}
                  className={`flex-1 min-w-0 px-3 py-2 border-0 focus:ring-0 focus:outline-none ${isLocked ? 'bg-gray-100 text-gray-600 cursor-not-allowed' : ''}`}
                  placeholder={documentTypeForInput === 'PE' ? '8 dígitos' : '10 dígitos'}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={beneficiary.email}
                disabled={isLocked}
                onChange={(e) => setBeneficiary((b) => ({ ...b, email: e.target.value }))}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 ${isLocked ? 'border-gray-200 bg-gray-100 text-gray-600 cursor-not-allowed' : 'border-gray-300'}`}
                placeholder="opcional@email.com"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre <span className="text-red-600">*</span></label>
              <input
                type="text"
                value={beneficiary.first_name}
                disabled
                className="w-full px-3 py-2 border border-gray-200 bg-gray-100 text-gray-600 rounded-lg cursor-not-allowed"
                placeholder="Se completa automáticamente"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Apellido <span className="text-red-600">*</span></label>
              <input
                type="text"
                value={beneficiary.last_name}
                disabled
                className="w-full px-3 py-2 border border-gray-200 bg-gray-100 text-gray-600 rounded-lg cursor-not-allowed"
                placeholder="Se completa automáticamente"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono</label>
              <input
                type="tel"
                value={beneficiary.phone}
                disabled
                className="w-full px-3 py-2 border border-gray-200 bg-gray-100 text-gray-600 rounded-lg cursor-not-allowed"
                placeholder="Teléfono"
              />
            </div>
          </div>
        </div>
      );
    }

    if (currentStep === 2) {
      const bankConfig: Record<string, { digits: number[]; label: string; color: string }> = {
        BCP: { digits: [13, 14], label: '13 o 14 dígitos', color: 'orange' },
        BBVA: { digits: [18], label: '18 dígitos', color: 'blue' },
        INTERBANK: { digits: [13], label: '13 dígitos', color: 'green' },
      };
      const selectedBank = bankConfig[formData.bank] || null;
      const accountDigits = formData.accountNumber.length;
      const isAccountValid = selectedBank ? selectedBank.digits.includes(accountDigits) : false;
      const isAccountPartial = selectedBank && accountDigits > 0 && accountDigits < Math.max(...selectedBank.digits);

      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">¿Dónde recibir el dinero?</h2>
            <p className="text-sm text-gray-500 mt-1">Selecciona cómo quiere recibir el préstamo el solicitante.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setFormData((p) => ({ ...p, depositType: 'yango' }))}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                formData.depositType === 'yango'
                  ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${formData.depositType === 'yango' ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  <DollarSign className="w-5 h-5" />
                </div>
                <div>
                  <p className={`font-medium ${formData.depositType === 'yango' ? 'text-red-700' : 'text-gray-900'}`}>Yango Pro</p>
                  <p className="text-xs text-gray-500">Abono directo en la app</p>
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setFormData((p) => ({ ...p, depositType: 'bank', accountType: 'CUENTA DE AHORRO' }))}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                formData.depositType === 'bank'
                  ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center ${formData.depositType === 'bank' ? 'bg-red-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  <CreditCard className="w-5 h-5" />
                </div>
                <div>
                  <p className={`font-medium ${formData.depositType === 'bank' ? 'text-red-700' : 'text-gray-900'}`}>Cuenta bancaria</p>
                  <p className="text-xs text-gray-500">Transferencia a su banco</p>
                </div>
              </div>
            </button>
          </div>

          {formData.depositType === 'bank' && (
            <div className="space-y-5 pt-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">Selecciona el banco</label>
                <div className="grid grid-cols-3 gap-3">
                  {Object.entries(bankConfig).map(([bank, config]) => (
                    <button
                      key={bank}
                      type="button"
                      onClick={() => setFormData((p) => ({ ...p, bank, accountNumber: '', bankAccountInputType: '', savingsAccountOrCci: '' }))}
                      className={`p-3 rounded-lg border-2 text-center transition-all ${
                        formData.bank === bank
                          ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <p className={`font-semibold ${formData.bank === bank ? 'text-red-700' : 'text-gray-800'}`}>{bank}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{config.label}</p>
                    </button>
                  ))}
                </div>
              </div>

              {formData.bank && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-3">Tipo de dato a ingresar</label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setFormData((p) => ({ ...p, bankAccountInputType: 'ahorros', savingsAccountOrCci: '' }))}
                        className={`flex-1 p-3 rounded-lg border-2 text-center transition-all ${
                          formData.bankAccountInputType === 'ahorros'
                            ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <p className={`font-semibold ${formData.bankAccountInputType === 'ahorros' ? 'text-red-700' : 'text-gray-800'}`}>Cuenta de ahorro</p>
                        <p className="text-xs text-gray-500 mt-0.5">Número de cuenta</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData((p) => ({ ...p, bankAccountInputType: 'cci', accountNumber: '' }))}
                        className={`flex-1 p-3 rounded-lg border-2 text-center transition-all ${
                          formData.bankAccountInputType === 'cci'
                            ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <p className={`font-semibold ${formData.bankAccountInputType === 'cci' ? 'text-red-700' : 'text-gray-800'}`}>CCI</p>
                        <p className="text-xs text-gray-500 mt-0.5">Código de Cuenta Interbancario (20 dígitos)</p>
                      </button>
                    </div>
                  </div>

                  {formData.bankAccountInputType === 'ahorros' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Número de cuenta de ahorro <span className="text-red-600">*</span>
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={formData.accountNumber}
                          onChange={(e) => {
                            const maxLen = Math.max(...(selectedBank?.digits || [20]));
                            setFormData((p) => ({ ...p, accountNumber: e.target.value.replace(/\D/g, '').slice(0, maxLen) }));
                          }}
                          className={`w-full px-3 py-2.5 border-2 rounded-lg transition-colors ${
                            isAccountValid
                              ? 'border-green-500 bg-green-50 focus:ring-2 focus:ring-green-200'
                              : isAccountPartial
                              ? 'border-yellow-400 focus:ring-2 focus:ring-yellow-200'
                              : 'border-gray-300 focus:ring-2 focus:ring-red-200 focus:border-red-500'
                          }`}
                          placeholder={`Ingresa ${selectedBank?.label || 'el número de cuenta'}`}
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                          <span className={`text-xs font-medium ${isAccountValid ? 'text-green-600' : isAccountPartial ? 'text-yellow-600' : 'text-gray-400'}`}>
                            {accountDigits}/{selectedBank?.digits.join(' o ')}
                          </span>
                          {isAccountValid && (
                            <CheckCircle className="w-5 h-5 text-green-500" />
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-gray-500 mt-1.5">
                        Cuenta de ahorro en soles · {formData.bank}
                      </p>
                    </div>
                  )}

                  {formData.bankAccountInputType === 'cci' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        CCI (Código de Cuenta Interbancario) <span className="text-red-600">*</span>
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={formData.savingsAccountOrCci}
                          onChange={(e) =>
                            setFormData((p) => ({ ...p, savingsAccountOrCci: e.target.value.replace(/\D/g, '').slice(0, 20) }))
                          }
                          className={`w-full px-3 py-2.5 border-2 rounded-lg transition-colors ${
                            formData.savingsAccountOrCci.length === 20
                              ? 'border-green-500 bg-green-50 focus:ring-2 focus:ring-green-200'
                              : 'border-gray-300 focus:ring-2 focus:ring-red-200 focus:border-red-500'
                          }`}
                          placeholder="20 dígitos"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                          <span className={`text-xs font-medium ${formData.savingsAccountOrCci.length === 20 ? 'text-green-600' : 'text-gray-400'}`}>
                            {formData.savingsAccountOrCci.length}/20
                          </span>
                          {formData.savingsAccountOrCci.length === 20 && (
                            <CheckCircle className="w-5 h-5 text-green-500" />
                          )}
                        </div>
                      </div>
                      <p className="text-xs text-gray-500 mt-1.5">
                        CCI de 20 dígitos para transferencias interbancarias.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      );
    }

    if (currentStep === 3) {
      const quickPurposes = [
        'Gastos del vehículo',
        'Emergencia personal',
        'Mantenimiento',
        'Combustible',
        'Pago de deudas',
        'Otros gastos',
      ];

      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">¿Cuánto necesita?</h2>
            <p className="text-sm text-gray-500 mt-1">Ingresa el monto y el motivo del préstamo.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Monto solicitado <span className="text-red-600">*</span>
            </label>
            <div className="flex border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-red-500 focus-within:border-red-500">
              <span className="flex items-center justify-center px-4 py-3 bg-gray-50 text-xl font-semibold text-gray-600 border-r border-gray-300 min-w-[5rem]">
                {getCurrencyLabel(beneficiary.country || 'PE')}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={formData.requestedAmount}
                onChange={(e) => {
                  const raw = e.target.value.replace(',', '.');
                  const allowed = raw.replace(/[^\d.]/g, '');
                  const parts = allowed.split('.');
                  const filtered = parts.length > 1
                    ? parts[0] + '.' + parts.slice(1).join('').slice(0, 2)
                    : allowed;
                  setFormData((p) => ({ ...p, requestedAmount: filtered }));
                }}
                className="flex-1 min-w-0 px-4 py-3 text-lg font-semibold border-0 outline-none placeholder:text-gray-400"
                placeholder="0 o 0.00"
              />
            </div>
            <p className="text-xs mt-1.5 text-gray-500">Ingresa el monto que solicita el conductor</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              ¿Para qué necesita el dinero? <span className="text-red-600">*</span>
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
              {quickPurposes.map((purpose) => (
                <button
                  key={purpose}
                  type="button"
                  onClick={() => setFormData((p) => ({ ...p, purpose }))}
                  className={`px-3 py-1.5 text-sm rounded-full border transition-all ${
                    formData.purpose === purpose
                      ? 'border-red-500 bg-red-50 text-red-700 font-medium'
                      : 'border-gray-300 hover:border-gray-400 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {purpose}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={formData.purpose}
              onChange={(e) => setFormData((p) => ({ ...p, purpose: e.target.value }))}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg outline-none focus:border-red-500"
              placeholder="O escribe otro motivo..."
            />
          </div>
        </div>
      );
    }

    if (currentStep === 4) {
      const inputClass = "w-full px-3 py-2 border border-gray-300 rounded-lg outline-none focus:border-red-500";
      return (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-900">{offer?.requiresGuarantor ? 'Garante' : 'Persona de contacto'}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Documento <span className="text-red-600">*</span></label>
              <div className="relative">
                <input
                  type="text"
                  value={formData.contactDni}
                  onChange={(e) => {
                    const dni = e.target.value.replace(/\D/g, '').slice(0, 10);
                    // Limpiar nombre si el documento tiene menos de 8 dígitos
                    setFormData((p) => ({ ...p, contactDni: dni, contactName: dni.length < 8 ? '' : p.contactName }));
                    // Cancelar debounce anterior
                    if (contactDniDebounceRef.current) clearTimeout(contactDniDebounceRef.current);
                    // Si tiene 8 o más dígitos, esperar 3 segundos para decidir
                    if (dni.length >= 8) {
                      contactDniDebounceRef.current = setTimeout(() => {
                        // Leer el valor actual del formData dentro del timeout
                        setFormData((p) => {
                          const currentDni = p.contactDni.replace(/\D/g, '');
                          if (currentDni.length === 8) {
                            // Es DNI, consultar Factiliza
                            lookupContactDni(currentDni);
                          } else if (currentDni.length > 8) {
                            // Es cédula, limpiar nombre
                            return { ...p, contactName: '' };
                          }
                          return p;
                        });
                      }, 3000);
                    }
                  }}
                  maxLength={10}
                  className={inputClass}
                  placeholder="DNI o Cédula"
                />
                {contactDniLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <Loader2 className="w-4 h-4 animate-spin text-red-500" />
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre <span className="text-red-600">*</span></label>
              <input
                type="text"
                value={formData.contactName}
                onChange={(e) => setFormData((p) => ({ ...p, contactName: e.target.value }))}
                className={`${inputClass} ${contactDniLoading ? 'bg-gray-50' : ''}`}
                placeholder={contactDniLoading ? 'Buscando...' : 'Nombre completo'}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Teléfono <span className="text-red-600">*</span></label>
              <input
                type="tel"
                value={formData.contactPhone}
                onChange={(e) => {
                  let val = e.target.value.replace(/\D/g, '').slice(0, 9);
                  if (val.length > 0 && val[0] !== '9') val = '9' + val.slice(1);
                  setFormData((p) => ({ ...p, contactPhone: val }));
                }}
                maxLength={9}
                className={inputClass}
                placeholder="9XXXXXXXX"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Parentesco / Relación</label>
              <input
                type="text"
                value={formData.contactRelationship}
                onChange={(e) => {
                  const val = e.target.value;
                  const formatted = val.charAt(0).toUpperCase() + val.slice(1);
                  setFormData((p) => ({ ...p, contactRelationship: formatted }));
                }}
                className={inputClass}
                placeholder="Ej. Familiar"
              />
            </div>
          </div>
          {offer?.requiresGuarantor && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Foto DNI frontal del garante <span className="text-red-600">*</span></label>
                <input type="file" accept="image/*" onChange={(e) => setFormData((p) => ({ ...p, contactFrontPhoto: e.target.files?.[0] ?? null }))} className="w-full text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Firma del garante</label>
                <div className="border border-gray-300 rounded-lg overflow-hidden bg-gray-50">
                  <canvas ref={contactSignatureRef} width={400} height={150} className="w-full h-[150px] touch-none block border-0" style={{ touchAction: 'none' }} onMouseDown={(e) => handleSigStart(e, true)} onMouseMove={(e) => handleSigMove(e, true)} onMouseLeave={() => handleSigEnd(true)} onMouseUp={() => handleSigEnd(true)} onTouchStart={(e) => handleSigStart(e, true)} onTouchMove={(e) => handleSigMove(e, true)} onTouchEnd={() => handleSigEnd(true)} />
                  <button type="button" onClick={() => clearSig(true)} className="mt-1 text-sm text-red-600 hover:underline">Limpiar firma</button>
                </div>
              </div>
            </>
          )}
        </div>
      );
    }

    if (currentStep === 5) {
      const opt = loanOptions?.option;
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Plan de pago</h2>
            <p className="text-sm text-gray-500 mt-1">Revisa y selecciona el plan de cuotas.</p>
          </div>

          {loading && !opt ? (
            <div className="flex items-center justify-center gap-3 py-12 bg-gray-50 rounded-xl">
              <Loader2 className="w-6 h-6 animate-spin text-red-500" />
              <span className="text-gray-600">Calculando opciones...</span>
            </div>
          ) : null}

          {opt && (
            <button
              type="button"
              onClick={() => setFormData((p) => ({ ...p, selectedOption: 1 }))}
              className={`w-full text-left p-5 rounded-xl border-2 transition-all ${
                formData.selectedOption === 1
                  ? 'border-red-500 bg-red-50 ring-2 ring-red-200'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-3">
                    <Calendar className="w-5 h-5 text-red-500" />
                    <span className="font-semibold text-gray-900">{opt.weeks} cuotas semanales</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-white rounded-lg p-3 border border-gray-100">
                      <p className="text-xs text-gray-500 mb-1">Monto solicitado</p>
                      <p className="text-lg font-bold text-gray-900">{formatCurrency(parseFloat(formData.requestedAmount || '0') || 0, beneficiary.country || 'PE')}</p>
                    </div>
                    <div className="bg-white rounded-lg p-3 border border-gray-100">
                      <p className="text-xs text-gray-500 mb-1">Cuota semanal</p>
                      <p className="text-lg font-bold text-gray-900">{formatCurrency(Number(opt.weeklyInstallment) || 0, beneficiary.country || 'PE')}</p>
                    </div>
                    <div className="bg-white rounded-lg p-3 border border-gray-100">
                      <p className="text-xs text-gray-500 mb-1">Última cuota</p>
                      <p className="text-lg font-bold text-gray-900">{formatCurrency(Number(opt.lastInstallment) || 0, beneficiary.country || 'PE')}</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between">
                    <span className="text-sm text-gray-600">Total a pagar</span>
                    <span className="text-xl font-bold text-red-600">{formatCurrency(Number(opt.totalAmount) || 0, beneficiary.country || 'PE')}</span>
                  </div>
                </div>
                <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ml-4 mt-1 ${
                  formData.selectedOption === 1 ? 'border-red-500 bg-red-500' : 'border-gray-300'
                }`}>
                  {formData.selectedOption === 1 && <CheckCircle className="w-4 h-4 text-white" />}
                </div>
              </div>
            </button>
          )}

          {!loading && !opt && (
            <div className="text-center py-12 bg-gray-50 rounded-xl">
              <p className="text-gray-500">No se pudo calcular el plan de pago.</p>
              <p className="text-sm text-gray-400 mt-1">Verifica el monto solicitado.</p>
            </div>
          )}
        </div>
      );
    }

    if (currentStep === 6) {
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Términos y condiciones</h2>
            <p className="text-sm text-gray-500 mt-1">El solicitante debe aceptar los términos del préstamo Rapidín.</p>
          </div>

          <div className="bg-gray-50 rounded-xl p-5 border border-gray-200 max-h-64 overflow-y-auto">
            <h3 className="font-semibold text-gray-900 mb-3">Condiciones del préstamo</h3>
            <ul className="space-y-2 text-sm text-gray-600">
              <li className="flex items-start gap-2">
                <span className="text-red-500 mt-0.5">•</span>
                <span>El préstamo será descontado automáticamente de las ganancias semanales del conductor.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-500 mt-0.5">•</span>
                <span>Los pagos se realizarán cada lunes hasta completar el total acordado.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-500 mt-0.5">•</span>
                <span>En caso de mora, se aplicarán los cargos por mora establecidos según el país.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-500 mt-0.5">•</span>
                <span>El conductor se compromete a mantener actividad en la plataforma durante el período del préstamo.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-red-500 mt-0.5">•</span>
                <span>La información proporcionada es veraz y puede ser verificada.</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            onClick={() => setFormData((p) => ({ ...p, termsAccepted: !p.termsAccepted }))}
            className={`w-full p-4 rounded-xl border-2 transition-all flex items-center gap-4 ${
              formData.termsAccepted
                ? 'border-green-500 bg-green-50'
                : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
              formData.termsAccepted
                ? 'border-green-500 bg-green-500'
                : 'border-gray-300'
            }`}>
              {formData.termsAccepted && <CheckCircle className="w-4 h-4 text-white" />}
            </div>
            <div className="text-left">
              <p className={`font-medium ${formData.termsAccepted ? 'text-green-700' : 'text-gray-900'}`}>
                Acepto los términos y condiciones <span className="text-red-600">*</span>
              </p>
              <p className="text-xs text-gray-500 mt-0.5">El solicitante ha leído y acepta las condiciones del préstamo</p>
            </div>
          </button>
        </div>
      );
    }

    if (currentStep === 7) {
      const hasSignature = !!formData.contractSignature || hasCanvasContent(signatureRef.current);
      return (
        <div className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Firma y documento</h2>
            <p className="text-sm text-gray-500 mt-1">Sube el DNI y obtén la firma del solicitante para finalizar.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {/* Documento DNI */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Foto del DNI <span className="text-red-600">*</span>
              </label>
              <label
                className={`flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-xl cursor-pointer transition-all ${
                  formData.idDocument
                    ? 'border-green-500 bg-green-50'
                    : 'border-gray-300 hover:border-red-400 hover:bg-red-50'
                }`}
              >
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={(e) => setFormData((p) => ({ ...p, idDocument: e.target.files?.[0] ?? null }))}
                  className="hidden"
                />
                {formData.idDocument ? (
                  <>
                    <CheckCircle className="w-10 h-10 text-green-500 mb-2" />
                    <p className="text-sm font-medium text-green-700">Documento cargado</p>
                    <p className="text-xs text-green-600 mt-1 truncate max-w-full">{formData.idDocument.name}</p>
                  </>
                ) : (
                  <>
                    <Camera className="w-10 h-10 text-gray-400 mb-2" />
                    <p className="text-sm font-medium text-gray-700">Subir foto del DNI</p>
                    <p className="text-xs text-gray-500 mt-1">JPG, PNG o PDF</p>
                  </>
                )}
              </label>
            </div>

            {/* Firma */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Firma del solicitante <span className="text-red-600">*</span>
              </label>
              <div className={`border-2 rounded-xl overflow-hidden transition-all ${
                hasSignature ? 'border-green-500' : 'border-gray-300'
              }`}>
                <div className="bg-white p-1">
                  <canvas
                    ref={signatureRef}
                    width={400}
                    height={150}
                    className="w-full h-[150px] touch-none block bg-gray-50 rounded-lg"
                    style={{ touchAction: 'none' }}
                    onMouseDown={(e) => handleSigStart(e, false)}
                    onMouseMove={(e) => handleSigMove(e, false)}
                    onMouseLeave={() => handleSigEnd(false)}
                    onMouseUp={() => handleSigEnd(false)}
                    onTouchStart={(e) => handleSigStart(e, false)}
                    onTouchMove={(e) => handleSigMove(e, false)}
                    onTouchEnd={() => handleSigEnd(false)}
                  />
                </div>
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-t">
                  <span className={`text-xs ${hasSignature ? 'text-green-600' : 'text-gray-500'}`}>
                    {hasSignature ? '✓ Firma capturada' : 'Dibuja la firma aquí'}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearSig(false)}
                    className="text-xs text-red-600 hover:text-red-700 font-medium"
                  >
                    Limpiar
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="space-y-6">
      <div className="bg-red-800 text-white rounded-lg p-4 flex items-center gap-3">
        <DollarSign className="w-10 h-10 flex-shrink-0" />
        <div>
          <h1 className="text-xl font-bold">Nueva solicitud</h1>
          <p className="text-sm text-red-100">Completa los datos del solicitante y del préstamo.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow border border-gray-100 p-4">
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
          {STEPS.map((s) => {
            const Icon = s.icon;
            const active = currentStep === s.number;
            const done = currentStep > s.number;
            return (
              <div key={s.number} className="flex items-center gap-1">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${active ? 'bg-red-600 text-white' : done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                  {done ? <CheckCircle className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                </div>
                <span className={`text-xs font-medium hidden sm:inline ${active ? 'text-red-600' : done ? 'text-green-600' : 'text-gray-400'}`}>{s.name}</span>
                {s.number < 7 && <span className="text-gray-300 mx-0.5">/</span>}
              </div>
            );
          })}
        </div>

        <div className="min-h-[280px]">{renderStep()}</div>

        <div className="flex justify-between mt-8 pt-4 border-t">
          <button type="button" onClick={() => setCurrentStep((s) => Math.max(1, s - 1))} disabled={currentStep === 1 || loading} className="flex items-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            <ArrowLeft className="w-4 h-4" />
            Atrás
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={loading}
            className="flex items-center gap-2 px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : currentStep === 7 ? 'Crear solicitud' : 'Siguiente'}
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

    </div>
  );
}
