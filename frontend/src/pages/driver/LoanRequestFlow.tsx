import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredSelectedParkId, getStoredSelectedExternalDriverId, getStoredRapidinDriverId } from '../../utils/authStorage';
import { formatCurrency, getCurrencyLabel } from '../../utils/currency';
import api from '../../services/api';
import toast from 'react-hot-toast';
import {
  CheckCircle, ArrowLeft, ArrowRight, User, CreditCard, FileText, Users,
  Calendar, DollarSign, FileCheck, Camera, Trash2, Loader2, Info, X
} from 'lucide-react';

interface FormData {
  // Paso 2: Datos Bancarios
  depositType: 'yango' | 'bank';
  bank: string;
  accountType: string;
  accountNumber: string;
  
  // Paso 3: Solicitud de Préstamo
  requestedAmount: string;
  purpose: string;
  
  // Paso 4: Persona de Contacto / Garante
  contactName: string;
  contactDni: string;
  contactPhone: string;
  contactRelationship: string;
  contactSignature: string;
  /** Foto parte frontal del DNI del garante (solo cuando requiresGuarantor) */
  contactFrontPhoto: File | null;
  
  // Paso 5: Opciones de Cuoteo
  selectedOption: number | null;
  
  // Paso 6: Términos y Condiciones
  termsAccepted: boolean;
  
  // Paso 7: Firma y Documento
  contractSignature: string;
  idDocument: File | null;
}

// Parsea "YYYY-MM-DD" como fecha local (evita desfase de 1 día por UTC)
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}
// Formatea Date a "YYYY-MM-DD" en hora local
function formatLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Validación de número de cuenta según banco (solo dígitos, sin CCI)
function validateBankAccountNumber(bank: string, accountNumber: string): { valid: boolean; message?: string } {
  const digits = accountNumber.replace(/\D/g, '');
  if (!digits.length) return { valid: false, message: 'Ingresa el número de cuenta' };
  switch (bank) {
    case 'BCP':
      if (digits.length !== 13 && digits.length !== 14) return { valid: false, message: 'BCP: el número de cuenta debe tener 13 o 14 dígitos (soles)' };
      break;
    case 'BBVA':
      if (digits.length !== 18) return { valid: false, message: 'BBVA: el número de cuenta debe tener 18 dígitos' };
      break;
    case 'INTERBANK':
      if (digits.length !== 13) return { valid: false, message: 'Interbank: el número de cuenta debe tener 13 dígitos' };
      break;
    default:
      return { valid: true };
  }
  return { valid: true };
}

function getBankAccountHint(bank: string): string {
  switch (bank) {
    case 'BCP': return 'BCP: 13 o 14 dígitos (solo números, sin guiones ni CCI)';
    case 'BBVA': return 'BBVA: 18 dígitos (solo números)';
    case 'INTERBANK': return 'Interbank: 13 dígitos (solo números)';
    default: return 'Ingresa solo números de cuenta (no CCI)';
  }
}

const steps = [
  { number: 1, name: 'Verificación de Identidad', icon: User },
  { number: 2, name: 'Datos Bancarios', icon: CreditCard },
  { number: 3, name: 'Solicitud de Préstamo', icon: FileText },
  { number: 4, name: 'Persona de Contacto', icon: Users },
  { number: 5, name: 'Opciones de Cuoteo', icon: Calendar },
  { number: 6, name: 'Términos y Condiciones', icon: FileCheck },
  { number: 7, name: 'Firma y Documento', icon: Camera },
];

function LoanRequestFlow() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [offer, setOffer] = useState<{ cycle: number; maxAmount: number; requiresGuarantor?: boolean } | null>(null);
  const [loanOptions, setLoanOptions] = useState<any>(null);
  const [driverInfo, setDriverInfo] = useState<any>(null);
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockingMessage, setBlockingMessage] = useState<string | null>(null);
  const [blockingFlotas, setBlockingFlotas] = useState<Array<{ flota_name: string; status?: string }>>([]);
  const [canRequestFromDate] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(true);
  const signatureRef = useRef<HTMLCanvasElement>(null);
  const contactSignatureRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const hasLoadedData = useRef(false);
  const isLoadingDriverInfo = useRef(false);
  const isLoadingOffer = useRef(false);
  const lastLoadedAmountRef = useRef<string | null>(null);
  const isSubmittingRef = useRef(false);
  const stepsScrollRef = useRef<HTMLDivElement>(null);

  const [formData, setFormData] = useState<FormData>({
    depositType: 'yango',
    bank: '',
    accountType: '',
    accountNumber: '',
    requestedAmount: '',
    purpose: '',
    contactName: '',
    contactDni: '',
    contactPhone: '',
    contactRelationship: '',
    contactSignature: '',
    contactFrontPhoto: null,
    selectedOption: null,
    termsAccepted: false,
    contractSignature: '',
    idDocument: null,
  });

  /** Datos del conductor para la solicitud: endpoint dedicado (no dashboard). Si hay rapidin_driver_id en localStorage, jala DNI de rapidin_drivers; si no, consulta drivers por teléfono y usa license_number solo dígitos. */
  const loadConductorData = async () => {
    if (isLoadingDriverInfo.current) return;
    isLoadingDriverInfo.current = true;
    try {
      setCheckingStatus(true);
      const rapidinDriverId = getStoredRapidinDriverId();
      const params = new URLSearchParams();
      if (rapidinDriverId) params.set('rapidin_driver_id', rapidinDriverId);
      const response = await api.get('/driver/conductor-data', { params: Object.fromEntries(params) });
      const data = response.data?.data;
      if (data) {
        setDriverInfo({
          id: data.id,
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          phone: data.phone ?? '',
          documentNumber: data.documentNumber ?? null,
          park_id: data.park_id ?? null,
        });
      }
    } catch (err: any) {
      console.error('Error loading conductor data:', err);
      const msg = err.response?.data?.message || err.message;
      if (err.response?.status === 404) toast.error(msg);
    } finally {
      setCheckingStatus(false);
      isLoadingDriverInfo.current = false;
    }
  };

  useEffect(() => {
    if (currentStep === 5 && formData.requestedAmount) {
      const amountChanged = lastLoadedAmountRef.current !== formData.requestedAmount;
      if (!loanOptions || amountChanged) {
        lastLoadedAmountRef.current = formData.requestedAmount;
        loadLoanOptions();
      }
    }
  }, [currentStep, formData.requestedAmount]);

  useEffect(() => {
    if (currentStep === 7) {
      initCanvas(false);
    }
    if (currentStep === 4) {
      initCanvas(true);
    }
  }, [currentStep]);

  // Hacer scroll al indicador del paso actual para que siempre se vea (sobre todo en móvil)
  useEffect(() => {
    const container = stepsScrollRef.current;
    if (!container) return;
    const activeEl = container.querySelector(`[data-step-number="${currentStep}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [currentStep]);

  const loadOffer = async () => {
    // Evitar llamadas duplicadas
    if (isLoadingOffer.current) return;
    isLoadingOffer.current = true;
    const parkId = getStoredSelectedParkId() || undefined;
    try {
      const externalDriverId = getStoredSelectedExternalDriverId() || undefined;
      const params = new URLSearchParams();
      if (parkId) params.set('park_id', parkId);
      if (externalDriverId) params.set('external_driver_id', externalDriverId);
      const response = await api.get('/driver/loan-offer', { params: Object.fromEntries(params) });
      setOffer(response.data.data);
    } catch (err: any) {
      console.error('Error loading offer:', err);
      const msg = err.response?.data?.message || err.message;
      const flotas = err.response?.data?.details?.flotas;
      if (msg && err.response?.status === 400) {
        setIsBlocked(true);
        setBlockingMessage(msg);
        setBlockingFlotas(Array.isArray(flotas) ? flotas : []);
      } else if (msg) toast.error(msg);
    } finally {
      isLoadingOffer.current = false;
    }
  };

  useEffect(() => {
    if (hasLoadedData.current) return;
    hasLoadedData.current = true;
    loadOffer();
    loadConductorData();
  }, []);

  const loadLoanOptions = async () => {
    try {
      setLoading(true);
      const response = await api.post('/driver/loan-simulate', {
        requestedAmount: formData.requestedAmount
      });
      
      const data = response.data.data;
      const option = data.option || data.option1;

      const generateSchedule = (opt: any, numWeeks: number, weeklyInstallment: number) => {
        const schedule = [];
        const startDate = parseLocalDate(opt.firstPaymentDate);
        for (let i = 0; i < numWeeks; i++) {
          const dueDate = new Date(startDate);
          dueDate.setDate(startDate.getDate() + (i * 7));
          schedule.push({
            installment: i + 1,
            dueDate: formatLocalDateStr(dueDate),
            amount: i === numWeeks - 1 ? opt.lastInstallment || weeklyInstallment : weeklyInstallment
          });
        }
        return schedule;
      };

      const schedule = option
        ? generateSchedule(option, option.weeks, option.weeklyInstallment)
        : [];
      const singleOption = option ? { ...option, schedule } : null;
      setLoanOptions({ option: singleOption });
    } catch (err: any) {
      console.error('Error loading loan options:', err);
      toast.error(err.response?.data?.message || 'Error al cargar las opciones de préstamo');
    } finally {
      setLoading(false);
    }
  };

  // Inicializar canvas de firma
  const initCanvas = (isContact = false) => {
    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };

  // Convierte coordenadas de pantalla a coordenadas del canvas (respeta escala interno vs CSS)
  const getCanvasCoords = (canvas: HTMLCanvasElement, clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const handleSignatureStart = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>, isContact = false) => {
    if ('touches' in e) e.preventDefault();
    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
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

  const handleSignatureMove = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>, isContact = false) => {
    if (!isDrawing) return;
    if ('touches' in e) e.preventDefault();

    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const { x, y } = getCanvasCoords(canvas, clientX, clientY);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const handleSignatureEnd = (isContact = false) => {
    setIsDrawing(false);
    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;

    // Verificar si el canvas tiene contenido antes de guardar
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hasContent = imageData.data.some((channel, index) => {
      // Verificar si hay píxeles no transparentes (cada 4 valores es un píxel RGBA)
      if (index % 4 === 3) { // Alpha channel
        return channel > 0;
      }
      return false;
    });

    if (hasContent) {
      const dataURL = canvas.toDataURL();
      if (isContact) {
        setFormData({ ...formData, contactSignature: dataURL });
      } else {
        setFormData({ ...formData, contractSignature: dataURL });
      }
    }
  };

  const clearSignature = (isContact = false) => {
    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isContact) {
      setFormData({ ...formData, contactSignature: '' });
    } else {
      setFormData({ ...formData, contractSignature: '' });
    }
  };

  // Función auxiliar para verificar si el canvas tiene contenido
  const checkCanvasHasContent = (canvas: HTMLCanvasElement | null): boolean => {
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Verificar si hay píxeles no transparentes
    for (let i = 3; i < imageData.data.length; i += 4) {
      if (imageData.data[i] > 0) { // Alpha channel > 0 significa que hay contenido
        return true;
      }
    }
    return false;
  };

  // Función auxiliar para guardar la firma del canvas al estado
  const saveSignatureFromCanvas = (isContact = false) => {
    const canvas = isContact ? contactSignatureRef.current : signatureRef.current;
    if (!canvas) return false;
    
    if (checkCanvasHasContent(canvas)) {
      const dataURL = canvas.toDataURL();
      if (isContact) {
        setFormData({ ...formData, contactSignature: dataURL });
      } else {
        setFormData({ ...formData, contractSignature: dataURL });
      }
      return true;
    }
    return false;
  };

  const validateStep = (step: number): boolean => {
    switch (step) {
      case 1:
        // El DNI se obtiene automáticamente del backend usando el número de licencia
        // Solo validamos que tengamos información del conductor
        if (!driverInfo) {
          toast.error('No se pudo cargar la información del conductor. Por favor, recarga la página.');
          return false;
        }
        return true;
      case 2:
        if (formData.depositType === 'bank') {
          if (!formData.bank || !formData.accountType || !formData.accountNumber) {
            toast.error('Completa todos los datos bancarios');
            return false;
          }
          const accountValidation = validateBankAccountNumber(formData.bank, formData.accountNumber);
          if (!accountValidation.valid) {
            toast.error(accountValidation.message ?? 'Número de cuenta inválido');
            return false;
          }
        }
        return true;
      case 3:
        if (!formData.requestedAmount || !formData.purpose) {
          toast.error('Completa el monto y el propósito del préstamo');
          return false;
        }
        const amount = parseFloat(formData.requestedAmount);
        if (isNaN(amount) || amount <= 0) {
          toast.error('El monto debe ser un número válido mayor a 0');
          return false;
        }
        if (amount < 10) {
          toast.error(`El monto mínimo a solicitar es ${formatCurrency(10, user?.country || 'PE')}`);
          return false;
        }
        if (offer && amount > offer.maxAmount) {
          toast.error(`El monto no puede exceder ${formatCurrency(offer.maxAmount, user?.country || 'PE')}`);
          return false;
        }
        return true;
      case 4: {
        const contactCfg = getContactFormCountryConfig(user?.country);
        let hasContactSignature = !!formData.contactSignature;
        if (offer?.requiresGuarantor && !hasContactSignature && checkCanvasHasContent(contactSignatureRef.current)) {
          hasContactSignature = saveSignatureFromCanvas(true);
        }
        const contactPhoneDigits = (formData.contactPhone || '').replace(/\D/g, '');
        const phoneComplete = contactPhoneDigits.length === contactCfg.phoneMaxLen;
        if (offer?.requiresGuarantor) {
          if (!formData.contactName || !formData.contactDni || !formData.contactFrontPhoto || !hasContactSignature) {
            toast.error(contactCfg.isCO ? 'Completa documento, nombre, foto del documento y firma del garante' : 'Completa DNI, nombre, foto del DNI y firma del garante');
            return false;
          }
          if (!phoneComplete) {
            toast.error(contactCfg.isCO ? 'Completa el teléfono del garante (10 dígitos)' : 'Completa el teléfono del garante');
            return false;
          }
        } else {
          if (!formData.contactName || !formData.contactDni || !formData.contactPhone || !formData.contactRelationship) {
            toast.error('Completa todos los datos de la persona de contacto');
            return false;
          }
          if (!phoneComplete) {
            toast.error(contactCfg.isCO ? 'Completa el teléfono de contacto (10 dígitos)' : 'Completa el teléfono de contacto (9 dígitos)');
            return false;
          }
        }
        if (driverInfo?.documentNumber && String(formData.contactDni).trim() === String(driverInfo.documentNumber).trim()) {
          toast.error(offer?.requiresGuarantor ? `El ${contactCfg.docLabel.toLowerCase()} del garante no puede ser el mismo que el tuyo` : `El ${contactCfg.docLabel.toLowerCase()} del contacto no puede ser el mismo que el tuyo`);
          return false;
        }
        if (phoneComplete) {
          const driverPhoneDigits = (driverInfo?.phone || '').replace(/\D/g, '');
          const driverLastN = contactCfg.isCO ? (driverPhoneDigits.length >= 10 ? driverPhoneDigits.slice(-10) : driverPhoneDigits) : (driverPhoneDigits.length >= 9 ? driverPhoneDigits.slice(-9) : driverPhoneDigits);
          if (driverLastN && contactPhoneDigits === driverLastN) {
            toast.error(offer?.requiresGuarantor ? 'El teléfono del garante no puede ser el mismo que el tuyo' : 'El teléfono del contacto no puede ser el mismo que el tuyo');
            return false;
          }
        }
        const docLen = String(formData.contactDni).trim().length;
        if (docLen < contactCfg.docMinLen || docLen > contactCfg.docMaxLen) {
          toast.error(contactCfg.isCO ? 'El documento (cédula) debe tener entre 6 y 10 dígitos' : 'El DNI debe tener 8 dígitos');
          return false;
        }
        return true;
      }
      case 5:
        if (formData.selectedOption === null) {
          toast.error('Selecciona un plan de pago');
          return false;
        }
        return true;
      case 6:
        if (!formData.termsAccepted) {
          toast.error('Debes aceptar los términos y condiciones');
          return false;
        }
        return true;
      case 7:
        // Verificar firma del contrato - primero en el estado, luego en el canvas
        let hasContractSignature = !!formData.contractSignature;
        if (!hasContractSignature && checkCanvasHasContent(signatureRef.current)) {
          hasContractSignature = saveSignatureFromCanvas(false);
        }

        if (!hasContractSignature) {
          toast.error('Debes firmar el contrato');
          return false;
        }

        if (!formData.idDocument) {
          toast.error('Debes subir una foto de tu DNI');
          return false;
        }

        return true;
      default:
        return true;
    }
  };

  const handleNext = () => {
    if (validateStep(currentStep)) {
      if (currentStep < 7) {
        setCurrentStep(currentStep + 1);
      } else {
        handleSubmit();
      }
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSubmit = async () => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    try {

      // Firma del CONDUCTOR: priorizar siempre el canvas al enviar (a veces el estado no se actualiza)
      let contractSignatureToSend: string | null = null;
      if (signatureRef.current && checkCanvasHasContent(signatureRef.current)) {
        contractSignatureToSend = signatureRef.current.toDataURL('image/png');
      } else if (formData.contractSignature) {
        contractSignatureToSend = formData.contractSignature;
      }
      // Firma del garante/contacto: estado o canvas como respaldo
      let contactSignatureToSend = formData.contactSignature;
      if (!contactSignatureToSend && contactSignatureRef.current && checkCanvasHasContent(contactSignatureRef.current)) {
        contactSignatureToSend = contactSignatureRef.current.toDataURL('image/png');
      }

      const submitData = new FormData();
      // DNI se obtiene automáticamente del backend usando el número de licencia del usuario
      if (driverInfo?.documentNumber) {
        submitData.append('dni', driverInfo.documentNumber);
      }
      // external_driver_id y park_id desde almacenamiento local (flota elegida); fallback user.driver_id
      const externalDriverId = getStoredSelectedExternalDriverId() || (user as { driver_id?: string })?.driver_id || '';
      const parkId = getStoredSelectedParkId() || '';
      submitData.append('driver_id', String(externalDriverId));
      submitData.append('external_driver_id', String(externalDriverId));
      submitData.append('park_id', String(parkId));
      submitData.append('requested_amount', formData.requestedAmount);
      submitData.append('purpose', formData.purpose);
      submitData.append('deposit_type', formData.depositType);
      if (formData.depositType === 'bank') {
        submitData.append('bank', formData.bank);
        submitData.append('account_type', formData.accountType);
        submitData.append('account_number', formData.accountNumber);
      }
      submitData.append('contact_name', formData.contactName || '');
      submitData.append('contact_dni', formData.contactDni);
      submitData.append('contact_phone', formData.contactPhone || '');
      submitData.append('contact_relationship', formData.contactRelationship || '');
      if (contactSignatureToSend) {
        submitData.append('contact_signature', contactSignatureToSend);
      }
      if (formData.contactFrontPhoto) {
        submitData.append('contact_front_photo', formData.contactFrontPhoto);
      }
      submitData.append('selected_option', formData.selectedOption?.toString() || '');
      // Enviar firma del conductor como archivo para evitar límites de tamaño en el body y asegurar que se guarde
      if (contractSignatureToSend) {
        try {
          const base64 = contractSignatureToSend.replace(/^data:image\/\w+;base64,/, '');
          const bytes = atob(base64);
          const u8 = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i++) u8[i] = bytes.charCodeAt(i);
          const blob = new Blob([u8], { type: 'image/png' });
          const file = new File([blob], 'contract-signature.png', { type: 'image/png' });
          submitData.append('contract_signature', file);
        } catch {
          submitData.append('contract_signature', contractSignatureToSend);
        }
      }
      if (formData.idDocument) {
        submitData.append('id_document', formData.idDocument);
      }

      await api.post('/driver/loan-request', submitData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      toast.success('Solicitud enviada exitosamente');
      navigate('/driver/loans');
    } catch (err: any) {
      console.error('Error submitting loan request:', err);
      toast.error(err.response?.data?.message || 'Error al enviar la solicitud');
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
    }
  };

  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return <Step1Identity driverInfo={driverInfo} user={user} />;
      case 2:
        return <Step2BankData formData={formData} setFormData={setFormData} />;
      case 3:
        return <Step3LoanRequest formData={formData} setFormData={setFormData} offer={offer} country={user?.country || 'PE'} />;
      case 4:
        return <Step4ContactPerson formData={formData} setFormData={setFormData} contactSignatureRef={contactSignatureRef} clearSignature={clearSignature} handleSignatureStart={handleSignatureStart} handleSignatureMove={handleSignatureMove} handleSignatureEnd={handleSignatureEnd} user={user} driverDocumentNumber={driverInfo?.documentNumber} driverPhone={driverInfo?.phone} requiresGuarantor={offer?.requiresGuarantor} />;
      case 5:
        return <Step5PaymentOptions formData={formData} setFormData={setFormData} loanOptions={loanOptions} loading={loading} driverCycle={offer?.cycle} requestedAmount={formData.requestedAmount} country={user?.country || 'PE'} />;
      case 6:
        return <Step6Terms formData={formData} setFormData={setFormData} />;
      case 7:
        return <Step7Signature formData={formData} setFormData={setFormData} signatureRef={signatureRef} clearSignature={clearSignature} handleSignatureStart={handleSignatureStart} handleSignatureMove={handleSignatureMove} handleSignatureEnd={handleSignatureEnd} />;
      default:
        return null;
    }
  };

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : '';

  // Mostrar spinner mientras verifica
  if (checkingStatus) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] sm:min-h-[60vh] px-4">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 sm:h-16 sm:w-16 border-4 border-red-600 border-t-transparent mx-auto mb-3 sm:mb-4" />
          <p className="text-sm sm:text-base text-gray-600">Verificando disponibilidad...</p>
        </div>
      </div>
    );
  }

  // Mostrar mensaje de bloqueo si tiene préstamo activo o solicitud pendiente
  if (isBlocked && blockingMessage) {
    return (
      <div className="space-y-3 sm:space-y-4 lg:space-y-6 px-2 sm:px-0">
        {/* Header */}
        <div className="bg-[#8B1A1A] rounded-xl sm:rounded-lg p-3 sm:p-4 lg:p-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
                <DollarSign className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
              </div>
              <div className="min-w-0">
                <h1 className="text-base sm:text-lg lg:text-xl font-bold text-white leading-tight truncate">
                  Solicitud de Préstamo Rapidín
                </h1>
                <p className="text-[10px] sm:text-xs lg:text-sm text-white/90 mt-0.5 truncate">
                  Yego Premium Oro - {countryName}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Mensaje de bloqueo */}
        <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col items-center justify-center text-center space-y-3 sm:space-y-4">
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-orange-100 rounded-full flex items-center justify-center flex-shrink-0">
              <Info className="w-7 h-7 sm:w-8 sm:h-8 text-orange-600" />
            </div>
            <div>
              <h2 className="text-lg sm:text-xl lg:text-2xl font-bold text-gray-900 mb-2">
                No puedes solicitar un nuevo préstamo
              </h2>
              <p className="text-gray-600 text-xs sm:text-sm lg:text-base max-w-md">
                {blockingMessage}
              </p>
              {blockingFlotas.length > 0 && (
                <div className="mt-3 sm:mt-4 max-w-md mx-auto text-left">
                  <p className="text-xs sm:text-sm font-semibold text-gray-700 mb-2">Flotas donde tienes crédito o solicitud en curso:</p>
                  <ul className="bg-gray-50 border border-gray-200 rounded-lg p-2.5 sm:p-3 space-y-1.5 max-h-32 sm:max-h-40 overflow-y-auto">
                    {blockingFlotas.map((f, i) => (
                      <li key={i} className="text-xs sm:text-sm text-gray-800 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                        {f.flota_name}
                        {f.status && (
                          <span className="text-gray-500 text-xs">({f.status === 'pending' ? 'pendiente' : f.status === 'approved' ? 'aprobada' : f.status === 'signed' ? 'firmada' : f.status === 'disbursed' ? 'desembolsada' : f.status})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canRequestFromDate && (
                <p className="mt-3 sm:mt-4 text-sm sm:text-base font-semibold text-red-600 bg-red-50 border border-red-200 rounded-lg py-2.5 sm:py-3 px-3 sm:px-4 max-w-md mx-auto">
                  Podrás solicitar un nuevo préstamo a partir del <span className="underline">{canRequestFromDate}</span>
                </p>
              )}
            </div>
            <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 mt-4 sm:mt-6 w-full sm:w-auto">
              <button
                onClick={() => navigate('/driver/resumen')}
                className="w-full min-h-[44px] bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 active:from-red-800 text-white font-semibold py-3 px-6 rounded-xl sm:rounded-lg transition-all shadow-md flex items-center justify-center gap-2 touch-manipulation"
              >
                <ArrowLeft className="w-5 h-5 flex-shrink-0" />
                Volver al Resumen
              </button>
              <button
                onClick={() => navigate('/driver/loans')}
                className="w-full min-h-[44px] bg-gray-100 hover:bg-gray-200 active:bg-gray-300 text-gray-700 font-semibold py-3 px-6 rounded-xl sm:rounded-lg transition-all flex items-center justify-center gap-2 touch-manipulation"
              >
                <FileText className="w-5 h-5 flex-shrink-0" />
                Ver Mis Préstamos
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 sm:space-y-4 lg:space-y-6 px-2 sm:px-0">
      {/* Header - compacto en móvil; en móvil se muestra el paso actual arriba */}
      <div className="bg-[#8B1A1A] rounded-xl sm:rounded-lg p-3 sm:p-4 lg:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-base sm:text-lg lg:text-xl font-bold text-white leading-tight truncate">
                Solicitud de Préstamo Rapidín
              </h1>
              <p className="text-[10px] sm:text-xs lg:text-sm text-white/90 mt-0.5 truncate">
                Yego Premium Oro - {countryName}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Steps Indicator - "X de 7" y nombre del paso actual dentro de este card */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-100 py-3 sm:py-5 lg:py-6">
        {/* Indicador "X de 7" y nombre del paso: solo en móvil/tablet; en pantalla grande no se muestra */}
        <div className="px-4 sm:px-6 mb-3 sm:mb-4 lg:hidden">
          <p className="text-center sm:text-left text-sm font-medium text-gray-700">
            <span className="inline-flex items-center justify-center min-w-[26px] h-6 px-1.5 rounded-md bg-red-100 text-red-700 font-bold mr-1.5">
              {currentStep}
            </span>
            <span>de 7 — {currentStep === 4 ? (offer?.requiresGuarantor ? 'Garante' : 'Persona de Contacto') : steps.find(s => s.number === currentStep)?.name}</span>
          </p>
        </div>
        <div ref={stepsScrollRef} className="overflow-x-auto overflow-y-hidden scroll-smooth scroll-pl-4 scroll-pr-4 pb-1 sm:pb-0">
          <div className="flex items-center justify-start sm:justify-center gap-0.5 sm:gap-1 lg:gap-2 min-w-min pl-4 pr-4 sm:pl-0 sm:pr-0">
            {steps.map((step, idx) => {
              const Icon = step.icon;
              const isActive = currentStep === step.number;
              const isCompleted = currentStep > step.number;
              const stepLabel = step.number === 4 ? (offer?.requiresGuarantor ? 'Garante' : 'Contacto') : step.name;
              return (
                <div key={step.number} data-step-number={step.number} className="flex items-center flex-shrink-0">
                  <div className="flex flex-col items-center min-w-[52px] sm:min-w-[70px] lg:min-w-[11rem] pt-1">
                    <div
                      className={`w-8 h-8 sm:w-10 sm:h-10 lg:w-12 lg:h-12 rounded-lg flex items-center justify-center font-bold text-sm transition-all duration-300 flex-shrink-0 ${
                        isActive
                          ? 'bg-gradient-to-br from-red-600 to-red-700 text-white shadow-lg ring-2 ring-red-200'
                          : isCompleted
                          ? 'bg-gradient-to-br from-green-500 to-green-600 text-white shadow-md'
                          : 'bg-gray-200 text-gray-500'
                      }`}
                    >
                      {isCompleted ? (
                        <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 lg:w-6 lg:h-6" />
                      ) : (
                        <Icon className="w-4 h-4 sm:w-5 sm:h-5 lg:w-6 lg:h-6" />
                      )}
                    </div>
                    {/* Nombres bajo el icono: ocultos en móvil, visibles en pantalla grande */}
                    <span className={`hidden sm:block text-[10px] lg:text-xs font-semibold mt-1 sm:mt-1.5 text-center leading-tight max-w-[70px] lg:max-w-[11rem] sm:truncate lg:truncate-none lg:whitespace-normal ${
                      isActive ? 'text-red-600' : isCompleted ? 'text-green-600' : 'text-gray-400'
                    }`} title={stepLabel}>
                      {stepLabel}
                    </span>
                  </div>
                  {idx < steps.length - 1 && (
                    <div className={`w-2 sm:w-4 lg:w-8 h-0.5 mx-0.5 transition-all duration-300 flex-shrink-0 ${
                      isCompleted ? 'bg-gradient-to-r from-green-500 to-green-400' : 'bg-gray-200'
                    }`} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Step Content */}
      <div className="bg-white rounded-xl shadow-lg border border-gray-100 p-4 sm:p-5 lg:p-6 animate-fade-in">
        {renderStepContent()}
        
        {/* Información Importante (solo paso 1) */}
        {currentStep === 1 && (
          <div className="bg-[#fefcea] rounded-lg border-l-2 border-[#e08a00] p-2.5 sm:p-3 lg:p-4 mt-4 sm:mt-6">
            <div className="flex items-start gap-2 sm:gap-3">
              <div className="flex-shrink-0 mt-0.5">
                <Info className="w-4 h-4 text-[#e08a00]" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-xs sm:text-sm lg:text-base font-bold text-[#e08a00] mb-1 sm:mb-1.5">
                  Importante
                </h3>
                <p className="text-[11px] sm:text-xs lg:text-sm text-[#e08a00] leading-relaxed">
                  <span className="font-semibold">Rapidín</span> es un beneficio exclusivo de <strong>Yego Premium Oro</strong>. Si dejas de ser conductor activo o no cumples con los requisitos (<strong>2 meses anteriores + 400 viajes</strong>), perderás el acceso a todos estos beneficios.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Buttons - siempre en una fila, táctiles */}
      <div className="flex flex-row items-center justify-between gap-2 sm:gap-4 mt-4 sm:mt-8">
        <button
          onClick={handleBack}
          disabled={currentStep === 1 || loading}
          className="flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-3 sm:px-6 py-3 rounded-xl font-bold bg-white border-2 border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400 active:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-md text-xs sm:text-base touch-manipulation flex-1 sm:flex-initial max-w-[50%] sm:max-w-none"
        >
          <ArrowLeft className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span>Atrás</span>
        </button>
        <button
          onClick={handleNext}
          disabled={loading}
          className="flex items-center justify-center gap-1.5 sm:gap-2 min-h-[44px] px-3 sm:px-8 py-3 rounded-xl font-bold bg-gradient-to-r from-red-600 via-red-600 to-red-700 text-white hover:from-red-700 hover:via-red-700 hover:to-red-800 active:from-red-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl text-xs sm:text-base touch-manipulation flex-1 sm:flex-initial max-w-[50%] sm:max-w-none"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" />
              <span>Procesando...</span>
            </>
          ) : currentStep === 7 ? (
            <>
              <span>Enviar Solicitud</span>
              <ArrowRight className="w-5 h-5 flex-shrink-0" />
            </>
          ) : (
            <>
              <span>Siguiente</span>
              <ArrowRight className="w-5 h-5 flex-shrink-0" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// Paso 1: Verificación de Identidad
function Step1Identity({ driverInfo, user }: any) {
  if (!driverInfo) {
    return (
      <div className="flex items-center justify-center py-8 sm:py-16">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 sm:h-16 sm:w-16 border-4 border-red-600 border-t-transparent mx-auto mb-4 sm:mb-6" />
          <p className="text-gray-600 text-sm sm:text-lg font-medium">Cargando información del conductor...</p>
        </div>
      </div>
    );
  }

  const countryName = user?.country === 'PE' ? 'Perú' : user?.country === 'CO' ? 'Colombia' : user?.country || '';

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header compacto */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-semibold text-gray-900">Verificación de Identidad</h2>
            <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Información verificada y validada</p>
          </div>
          <div className="flex items-center gap-2 bg-green-50 px-3 py-1.5 rounded-lg border border-green-200 w-fit">
            <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></div>
            <span className="text-xs font-medium text-green-700">Verificado</span>
          </div>
        </div>
      </div>

      {/* Información del conductor */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
          <h3 className="text-sm sm:text-base font-semibold text-gray-900">Datos del Conductor</h3>
        </div>
        
        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">
                Nombre Completo
              </label>
              <div className="text-sm font-medium text-gray-900">
                {driverInfo.firstName} {driverInfo.lastName}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">
                Teléfono
              </label>
              <div className="text-sm font-medium text-gray-900">
                {driverInfo.phone}
              </div>
            </div>

            {driverInfo.documentNumber && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">
                  {user?.country === 'PE' ? 'DNI' : 'Cédula'}
                </label>
                <div className="text-sm font-medium text-gray-900">
                  {driverInfo.documentNumber}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1 uppercase tracking-wider">
                País
              </label>
              <div className="text-sm font-medium text-gray-900">
                {countryName}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* Nota informativa */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
        <p className="text-[11px] sm:text-xs text-blue-900 leading-relaxed">
          <span className="font-semibold">Nota:</span> Tu identidad ha sido verificada automáticamente mediante tu número de licencia registrado en el sistema Yego.
        </p>
      </div>
    </div>
  );
}

// Paso 2: Datos Bancarios
function Step2BankData({ formData, setFormData }: any) {
  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">Datos Bancarios</h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Selecciona dónde deseas recibir tu préstamo</p>
        </div>
      </div>

      {/* Nota importante */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
        <p className="text-[11px] sm:text-xs text-blue-900 leading-relaxed">
          <span className="font-semibold">Importante:</span> Si eliges que vaya a tu Saldo de Yango Pro y tienes dinero en candado (saldos en revisión) puede que total o parcialmente quede retenido el saldo abonado por Rapidín.
        </p>
      </div>

      {/* Opciones de depósito */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
          <label className="block text-xs sm:text-sm font-semibold text-gray-900">
            ¿A dónde te abonamos? <span className="text-red-600">*</span>
          </label>
        </div>
        <div className="p-3 sm:p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 sm:gap-3">
            <label className={`flex items-center gap-2 sm:gap-3 p-3 sm:p-4 border-2 rounded-lg cursor-pointer transition-colors touch-manipulation min-h-[44px] ${
              formData.depositType === 'yango' 
                ? 'border-red-600 bg-red-50' 
                : 'border-gray-300 bg-white hover:border-gray-400'
            }`}>
              <input
                type="radio"
                name="depositType"
                value="yango"
                checked={formData.depositType === 'yango'}
                onChange={(e) => setFormData({ ...formData, depositType: e.target.value })}
                className="w-4 h-4 text-red-600 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-xs sm:text-sm text-gray-900 mb-0.5">YANGO PRO</div>
                <span className="text-[11px] sm:text-xs text-gray-600">A mi saldo de Yango Pro. El mismo dia que se aprueba la solicitud, el dinero sera acreditado a mi saldo de Yango Pro.</span>
              </div>
            </label>
            <label className={`flex items-center gap-2 sm:gap-3 p-3 sm:p-4 border-2 rounded-lg cursor-pointer transition-colors touch-manipulation min-h-[44px] ${
              formData.depositType === 'bank' 
                ? 'border-red-600 bg-red-50' 
                : 'border-gray-300 bg-white hover:border-gray-400'
            }`}>
              <input
                type="radio"
                name="depositType"
                value="bank"
                checked={formData.depositType === 'bank'}
                onChange={(e) => setFormData({ ...formData, depositType: e.target.value })}
                className="w-4 h-4 text-red-600 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-xs sm:text-sm text-gray-900 mb-0.5">CUENTA BANCARIA</div>
                <span className="text-[11px] sm:text-xs text-gray-600">A una cuenta bancaria. El desembolso se realizará en el plazo de 24 horas hábiles</span>
              </div>
            </label>
          </div>
        </div>
      </div>

      {formData.depositType === 'bank' && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          {/* Selección de Banco */}
          <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
            <label className="block text-xs sm:text-sm font-semibold text-gray-900 mb-0.5">
              Banco <span className="text-red-600">*</span>
            </label>
            <p className="text-[11px] sm:text-xs text-gray-600">Solo hacemos depósitos a estos bancos</p>
          </div>
          <div className="p-3 sm:p-4">
            <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
              {['BCP', 'BBVA', 'INTERBANK'].map((bank) => (
                <label
                  key={bank}
                  className={`flex flex-col items-center justify-center p-2 sm:p-3 border-2 rounded-lg cursor-pointer transition-colors touch-manipulation min-h-[44px] ${
                    formData.bank === bank 
                      ? 'border-red-600 bg-red-50' 
                      : 'border-gray-300 bg-white hover:border-gray-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="bank"
                    value={bank}
                    checked={formData.bank === bank}
                    onChange={(e) => setFormData({ ...formData, bank: e.target.value })}
                    className="w-4 h-4 text-red-600 mb-1 sm:mb-1.5 flex-shrink-0"
                  />
                  <span className="font-semibold text-[10px] sm:text-xs text-gray-900 text-center">{bank}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Tipo de Cuenta */}
          <div className="border-t border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
            <label className="block text-xs sm:text-sm font-semibold text-gray-900 mb-0.5">
              Tipo de Cuenta <span className="text-red-600">*</span>
            </label>
            <p className="text-[11px] sm:text-xs text-gray-600">No aceptamos cuentas en Dólares para este tipo de depósitos</p>
          </div>
          <div className="px-3 sm:px-4 pb-3 sm:pb-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {/* Por ahora solo Cuenta de Ahorro; Cuenta Corriente bloqueada */}
              {['CUENTA DE AHORRO'].map((type) => (
                <label
                  key={type}
                  className={`flex items-center justify-center p-3 border-2 rounded-lg cursor-pointer transition-colors touch-manipulation min-h-[44px] ${
                    formData.accountType === type 
                      ? 'border-red-600 bg-red-50' 
                      : 'border-gray-300 bg-white hover:border-gray-400'
                  }`}
                >
                  <input
                    type="radio"
                    name="accountType"
                    value={type}
                    checked={formData.accountType === type}
                    onChange={(e) => setFormData({ ...formData, accountType: e.target.value })}
                    className="w-4 h-4 text-red-600 mr-2 flex-shrink-0"
                  />
                  <span className="font-medium text-[11px] sm:text-xs text-gray-900 text-center leading-tight">{type}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Número de Cuenta */}
          <div className="border-t border-gray-200 px-3 sm:px-4 py-3 sm:py-4">
            <label className="block text-xs sm:text-sm font-semibold text-gray-900 mb-1.5 sm:mb-2">
              Número de Cuenta <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={formData.accountNumber}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, '');
                setFormData({ ...formData, accountNumber: value });
              }}
              placeholder={formData.bank ? getBankAccountHint(formData.bank) : 'Primero elige el banco'}
              maxLength={formData.bank === 'BBVA' ? 18 : 14}
              className="w-full min-h-[44px] px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation"
            />
            <p className="text-[11px] sm:text-xs text-gray-600 mt-2 bg-blue-50 p-2 sm:p-2.5 rounded-lg border border-blue-200 leading-relaxed">
              <span className="font-semibold">Nota:</span> Solo realizamos pagos a cuentas en BCP, BBVA, INTERBANK. Ingresa solo el número de cuenta (no CCI).
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Paso 3: Solicitud de Préstamo
function Step3LoanRequest({ formData, setFormData, offer, country = 'PE' }: any) {
  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">Solicitud de Préstamo</h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Indica el monto y propósito de tu préstamo</p>
        </div>
      </div>

      {/* Información sobre ciclos */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
        <p className="text-[11px] sm:text-xs text-blue-900 leading-relaxed">
          <span className="font-semibold">El préstamo funciona por ciclos.</span> Mientras más cumplas con tus pagos a Rapidín, más te prestamos. Puedes solicitar desde <span className="font-semibold">{formatCurrency(100, country)}</span> por solicitud.
        </p>
      </div>

      {/* Oferta disponible */}
      {offer && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></div>
              <p className="text-[11px] sm:text-xs text-gray-600">Según tu ciclo {offer.cycle}</p>
            </div>
            <p className="text-sm sm:text-base font-semibold text-gray-900">
              Puedes solicitar hasta <span className="text-red-600 text-base sm:text-lg">{formatCurrency(offer.maxAmount, country)}</span>
            </p>
          </div>
        </div>
      )}

      {/* Formulario */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
          <h3 className="text-xs sm:text-sm font-semibold text-gray-900">Monto del Préstamo</h3>
        </div>
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
          <div>
            <label className="block text-xs sm:text-sm font-semibold text-gray-900 mb-1.5 sm:mb-2">
              Monto Solicitado <span className="text-red-600">*</span>
            </label>
            <div className="relative">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 font-semibold text-xs sm:text-sm">
                {getCurrencyLabel(country)}
              </div>
              <input
                type="text"
                inputMode="decimal"
                value={formData.requestedAmount}
                onChange={(e) => {
                  const value = e.target.value.replace(/[^0-9.]/g, '');
                  const parts = value.split('.');
                  const filteredValue = parts.length > 2 
                    ? parts[0] + '.' + parts.slice(1).join('')
                    : value;
                  setFormData({ ...formData, requestedAmount: filteredValue });
                }}
                placeholder="Ingresa el monto"
                className="w-full min-h-[44px] pl-10 sm:pl-12 pr-3 sm:pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation"
              />
            </div>
            <p className="text-[11px] sm:text-xs text-gray-600 mt-2 bg-gray-50 p-2 rounded border border-gray-200">
              <span className="font-semibold">Monto:</span> Mínimo <span className="font-semibold text-red-600">{formatCurrency(10, country)}</span>
              {offer && (
                <> · Máximo según tu ciclo: <span className="font-semibold text-red-600">{formatCurrency(offer.maxAmount, country)}</span></>
              )}
              .
            </p>
          </div>

          <div>
            <label className="block text-xs sm:text-sm font-semibold text-gray-900 mb-1.5 sm:mb-2">
              ¿Para qué necesitas el dinero? <span className="text-red-600">*</span>
            </label>
            <textarea
              value={formData.purpose}
              onChange={(e) => setFormData({ ...formData, purpose: e.target.value })}
              placeholder="Describe para qué necesitas el préstamo (ej: reparación del vehículo, emergencia familiar, etc.)"
              rows={4}
              className="w-full min-h-[100px] px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none resize-none text-sm touch-manipulation"
            />
            <p className="text-[11px] sm:text-xs text-gray-500 mt-1.5">Mínimo 20 caracteres</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// Configuración del formulario contacto/garante por país (evita repetir conditionals y ambigüedad)
function getContactFormCountryConfig(country: string | undefined) {
  const isCO = country === 'CO';
  return {
    isCO,
    docLabel: isCO ? 'Documento (cédula)' : 'DNI',
    docMaxLen: isCO ? 10 : 8,
    docMinLen: isCO ? 6 : 8,
    docPlaceholder: isCO ? 'Cédula: 6 a 10 dígitos' : '8 dígitos',
    docHint: isCO ? 'Solo números, 6 a 10 dígitos (cédula)' : 'Solo números, 8 dígitos',
    docPhotoLabel: isCO ? 'documento' : 'DNI',
    docPhotoHint: isCO ? 'documento (cédula)' : 'DNI',
    phonePrefix: isCO ? '+57' : '+51',
    phoneMaxLen: isCO ? 10 : 9,
    phonePlaceholder: isCO ? '3001234567' : '999999999',
    namePlaceholder: isCO ? 'Ingresa el nombre completo' : 'Valida el DNI para autocompletar',
    nameHint: isCO ? 'Ingresa el nombre completo del garante' : 'Valida el DNI para autocompletar el nombre',
    useFactiliza: !isCO,
  };
}

// Paso 4: Persona de Contacto
function Step4ContactPerson({ formData, setFormData, contactSignatureRef, clearSignature, handleSignatureStart, handleSignatureMove, handleSignatureEnd, user, driverDocumentNumber, driverPhone, requiresGuarantor }: any) {
  const [contactDniValidated, setContactDniValidated] = useState(false);
  const [contactDniLoading, setContactDniLoading] = useState(false);
  const [showGaranteCamera, setShowGaranteCamera] = useState(false);
  const [garanteCameraError, setGaranteCameraError] = useState<string | null>(null);
  const garanteVideoRef = useRef<HTMLVideoElement>(null);
  const garanteCaptureCanvasRef = useRef<HTMLCanvasElement>(null);
  const garanteStreamRef = useRef<MediaStream | null>(null);
  const garanteFileInputRef = useRef<HTMLInputElement>(null);
  const contactDniError = driverDocumentNumber && formData.contactDni.trim() !== '' && String(formData.contactDni).trim() === String(driverDocumentNumber).trim();
  const driverPhoneDigits = (driverPhone || '').replace(/\D/g, '');
  const contactPhoneDigits = (formData.contactPhone || '').replace(/\D/g, '');
  const cfg = getContactFormCountryConfig(user?.country);
  const requiredPhoneLen = cfg.phoneMaxLen;
  const driverLastN = cfg.isCO ? (driverPhoneDigits.length >= 10 ? driverPhoneDigits.slice(-10) : driverPhoneDigits) : (driverPhoneDigits.length >= 9 ? driverPhoneDigits.slice(-9) : driverPhoneDigits);
  const contactPhoneError = contactPhoneDigits.length >= requiredPhoneLen && driverLastN && contactPhoneDigits === driverLastN;

  // Restaurar la firma en el canvas si existe
  useEffect(() => {
    if (formData.contactSignature && contactSignatureRef.current) {
      const canvas = contactSignatureRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = formData.contactSignature;
      }
    }
  }, [formData.contactSignature]);

  // Cámara garante: solo captura, sin subir archivo
  const stopGaranteStream = () => {
    if (garanteStreamRef.current) {
      garanteStreamRef.current.getTracks().forEach((t) => t.stop());
      garanteStreamRef.current = null;
    }
    setGaranteCameraError(null);
  };

  const openGaranteCamera = async () => {
    setGaranteCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      garanteStreamRef.current = stream;
      setShowGaranteCamera(true);
      setTimeout(() => {
        if (garanteVideoRef.current) garanteVideoRef.current.srcObject = stream;
      }, 0);
    } catch (err: any) {
      setGaranteCameraError(err?.message || 'No se pudo acceder a la cámara.');
      toast.error('No se pudo abrir la cámara');
    }
  };

  const closeGaranteCamera = () => {
    stopGaranteStream();
    setShowGaranteCamera(false);
    if (garanteVideoRef.current) garanteVideoRef.current.srcObject = null;
  };

  useEffect(() => {
    if (!showGaranteCamera) return;
    return () => { stopGaranteStream(); };
  }, [showGaranteCamera]);

  const captureGarantePhoto = () => {
    const video = garanteVideoRef.current;
    const canvas = garanteCaptureCanvasRef.current;
    if (!video || !canvas || !garanteStreamRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], 'dni-frontal-garante.jpg', { type: 'image/jpeg' });
        setFormData({ ...formData, contactFrontPhoto: file });
        closeGaranteCamera();
        toast.success('Foto del DNI del garante capturada');
      },
      'image/jpeg',
      0.9
    );
  };

  const onGaranteFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setFormData({ ...formData, contactFrontPhoto: file });
      toast.success('Archivo del garante cargado');
    }
    e.target.value = '';
  };

  // En dev: "Adjuntar foto" (selector de archivo). En producción: "Tomar foto" (cámara).
  const allowFileUpload = (import.meta as { env?: { DEV?: boolean; VITE_ALLOW_FILE_UPLOAD?: string } }).env?.VITE_ALLOW_FILE_UPLOAD === 'true' || (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header: Garante o Persona de Contacto */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">
            {requiresGuarantor ? 'Garante' : 'Persona de Contacto'}
          </h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">
            {requiresGuarantor
              ? 'Persona que respalda tu préstamo (obligatorio para tu ciclo)'
              : 'Información de contacto de referencia'}
          </p>
        </div>
      </div>

      {/* Nota importante */}
      <div className="bg-orange-50 border border-orange-200 rounded-lg p-2.5 sm:p-3">
        <p className="text-[11px] sm:text-xs text-orange-900 leading-relaxed">
          <span className="font-semibold">Importante:</span>{' '}
          {requiresGuarantor
            ? 'Para tu ciclo se requiere garante. El garante respalda tu préstamo. Llamaremos a esta persona para verificación y en caso de perder contacto contigo.'
            : 'Necesitamos una persona de contacto para tu solicitud. Llamaremos a esta persona para pedir una referencia sobre ti y en caso de perder contacto contigo durante el préstamo.'}
        </p>
      </div>

      {/* Garante: una fila con Datos del garante (izq) y Firma del garante (der) */}
      {requiresGuarantor ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          {/* Columna izquierda: Datos del garante */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900">Datos del Garante</h3>
            </div>
            <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">{cfg.docLabel} <span className="text-red-600">*</span></label>
                <div className="relative">
                  <input
                    type="text"
                    value={formData.contactDni}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, cfg.docMaxLen);
                      setFormData({ ...formData, contactDni: value, contactName: '' });
                      setContactDniValidated(false);
                    }}
                    onBlur={async () => {
                      if (!cfg.useFactiliza || formData.contactDni.length !== 8) return;
                      setContactDniLoading(true);
                      try {
                        const contactDniTrim = String(formData.contactDni).trim();
                        if (driverDocumentNumber && contactDniTrim === String(driverDocumentNumber).trim()) {
                          toast.error(`El ${cfg.docLabel} del garante no puede ser el mismo que el tuyo`);
                          return;
                        }
                        const { data } = await api.get(`/driver/validate-dni/${formData.contactDni}`);
                        const fullName = data?.data?.fullName;
                        if (fullName) {
                          setFormData((prev: FormData) => ({ ...prev, contactName: fullName }));
                          setContactDniValidated(true);
                        }
                      } catch (err: any) {
                        toast.error(err?.response?.data?.message || 'DNI no encontrado o inválido');
                      } finally {
                        setContactDniLoading(false);
                      }
                    }}
                    placeholder={cfg.docPlaceholder}
                    maxLength={cfg.docMaxLen}
                    className={`w-full min-h-[44px] px-3 py-2 pr-10 border-2 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation ${
                      contactDniError ? 'border-red-500' : contactDniValidated ? 'border-green-500' : 'border-gray-300'
                    }`}
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                    {contactDniLoading && <Loader2 className="w-5 h-5 animate-spin" />}
                    {!contactDniLoading && contactDniValidated && <CheckCircle className="w-5 h-5 text-green-600" />}
                  </div>
                </div>
                {contactDniError ? (
                  <p className="text-[11px] sm:text-xs text-red-600 mt-1">El {cfg.docLabel.toLowerCase()} del garante no puede ser el mismo que el tuyo</p>
                ) : (
                  <p className="text-[11px] sm:text-xs text-gray-500 mt-1">{cfg.docHint}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Nombre Completo del garante <span className="text-red-600">*</span></label>
                <input
                  type="text"
                  value={formData.contactName}
                  onChange={(e) => !contactDniValidated && setFormData({ ...formData, contactName: e.target.value })}
                  placeholder={cfg.namePlaceholder}
                  disabled={contactDniValidated}
                  className={`w-full min-h-[44px] px-3 py-2 border rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation ${
                    contactDniValidated ? 'border-green-500 bg-green-50/50 text-gray-800 cursor-not-allowed' : 'border-gray-300'
                  }`}
                />
                <p className="text-xs text-gray-500 mt-1">{cfg.nameHint}</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Teléfono del garante <span className="text-red-600">*</span></label>
                <div className={`flex items-center rounded-lg border-2 overflow-hidden min-h-[44px] ${contactPhoneError ? 'border-red-500' : contactPhoneDigits.length === requiredPhoneLen ? 'border-green-500' : 'border-gray-300'}`}>
                  <span className="px-2 sm:px-3 py-2 bg-gray-50 border-r border-gray-300 text-gray-600 text-xs sm:text-sm font-medium flex-shrink-0">{cfg.phonePrefix}</span>
                  <input
                    type="text"
                    value={formData.contactPhone}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, cfg.phoneMaxLen);
                      setFormData({ ...formData, contactPhone: value });
                    }}
                    placeholder={cfg.phonePlaceholder}
                    maxLength={cfg.phoneMaxLen}
                    className={`flex-1 min-w-0 px-3 py-2 border-0 focus:ring-2 focus:ring-red-500 focus:outline-none text-sm touch-manipulation ${contactPhoneError ? 'bg-red-50/30' : contactPhoneDigits.length === requiredPhoneLen ? 'bg-green-50/30' : ''}`}
                  />
                </div>
                {contactPhoneError && (
                  <p className="text-[11px] sm:text-xs text-red-600 mt-1">El teléfono del garante no puede ser el mismo que el tuyo</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Foto parte frontal del {cfg.docPhotoLabel} <span className="text-red-600">*</span></label>
                <p className="text-[11px] sm:text-xs text-gray-600 mb-2">Solo cámara. Toma una foto de la parte frontal del {cfg.docPhotoHint} del garante usando el marco como guía.</p>
                {formData.contactFrontPhoto ? (
                  <div className="space-y-2">
                    <div className="border border-gray-300 rounded-lg p-2.5 sm:p-3 bg-gray-50">
                      <div className="flex items-center justify-between mb-2 gap-2">
                        <p className="text-[11px] sm:text-xs font-medium text-gray-900 truncate flex-1 min-w-0">{formData.contactFrontPhoto.name}</p>
                        <button
                          type="button"
                          onClick={() => setFormData({ ...formData, contactFrontPhoto: null })}
                          className="text-xs text-red-600 hover:text-red-700 underline flex-shrink-0 touch-manipulation py-1"
                        >
                          Eliminar
                        </button>
                      </div>
                      {formData.contactFrontPhoto.type.startsWith('image/') && (
                        <img
                          src={URL.createObjectURL(formData.contactFrontPhoto)}
                          alt="DNI frontal garante"
                          className="w-full max-h-32 sm:max-h-40 object-contain rounded border border-gray-200"
                        />
                      )}
                    </div>
                    <p className="text-[11px] sm:text-xs text-green-600 flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                      Foto capturada correctamente
                    </p>
                  </div>
                ) : (
                  <div>
                    <input
                      ref={garanteFileInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={onGaranteFileChange}
                    />
                    {allowFileUpload ? (
                      <button
                        type="button"
                        onClick={() => garanteFileInputRef.current?.click()}
                        className="w-full sm:w-auto min-h-[44px] min-w-[140px] px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 active:bg-red-800 transition-colors touch-manipulation"
                      >
                        Adjuntar foto
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={openGaranteCamera}
                        className="w-full sm:w-auto min-h-[44px] min-w-[140px] px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 active:bg-red-800 transition-colors touch-manipulation"
                      >
                        Tomar Foto
                      </button>
                    )}
                    {garanteCameraError && (
                      <p className="text-xs text-red-600 mt-2">{garanteCameraError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Modal cámara garante: solo cámara, marco para encajar DNI frontal */}
          {showGaranteCamera && (
            <div className="fixed inset-0 z-50 flex flex-col bg-black">
              <video
                ref={garanteVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div className="absolute inset-0 flex flex-col items-center justify-center p-4 pointer-events-none">
                <div
                  className="w-full max-w-[280px] aspect-[1.58] border-4 border-dashed border-white rounded-lg bg-transparent"
                  style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
                />
                <p className="text-white text-center text-sm font-semibold drop-shadow-md mt-4 px-4">
                  Encaja el DNI frontal del garante dentro del marco
                </p>
              </div>
              <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 flex gap-2 sm:gap-3 justify-center bg-gradient-to-t from-black/80 to-transparent">
                <button
                  type="button"
                  onClick={closeGaranteCamera}
                  className="flex items-center justify-center gap-2 min-h-[44px] px-4 sm:px-5 py-2.5 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-500 pointer-events-auto touch-manipulation"
                >
                  <X className="w-4 h-4 flex-shrink-0" />
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={captureGarantePhoto}
                  className="flex items-center justify-center gap-2 min-h-[44px] px-4 sm:px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 pointer-events-auto touch-manipulation"
                >
                  <Camera className="w-4 h-4 flex-shrink-0" />
                  Capturar
                </button>
              </div>
              <canvas ref={garanteCaptureCanvasRef} className="hidden" />
            </div>
          )}

          {/* Columna derecha: Firma del garante */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900">Firma del Garante</h3>
            </div>
            <div className="p-3 sm:p-4 space-y-2 sm:space-y-3">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 sm:p-3">
                <p className="text-[11px] sm:text-xs text-blue-900 font-semibold mb-1">Al firmar, el garante autoriza a Yego Rapidín a:</p>
                <ul className="list-disc list-inside text-[11px] sm:text-xs text-blue-800 space-y-0.5">
                  <li>Verificar su identidad y respaldar el préstamo del conductor</li>
                  <li>Ser contactado en caso de no poder localizar al conductor</li>
                </ul>
              </div>
              <p className="text-[11px] sm:text-xs text-gray-600">Firma en el recuadro usando tu dedo o mouse.</p>
              <div className="border border-dashed border-gray-300 rounded-lg p-2 sm:p-3 bg-gray-50">
                <canvas
                  ref={contactSignatureRef}
                  width={600}
                  height={200}
                  style={{ width: '100%', maxWidth: '100%', height: 'clamp(140px, 28vw, 180px)', border: '1px solid #d1d5db', borderRadius: '0.5rem', backgroundColor: 'white', cursor: 'crosshair', touchAction: 'none' }}
                  onMouseDown={(e) => handleSignatureStart(e, true)}
                  onMouseMove={(e) => handleSignatureMove(e, true)}
                  onMouseUp={() => handleSignatureEnd(true)}
                  onMouseLeave={() => handleSignatureEnd(true)}
                  onTouchStart={(e) => handleSignatureStart(e, true)}
                  onTouchMove={(e) => handleSignatureMove(e, true)}
                  onTouchEnd={() => handleSignatureEnd(true)}
                />
              </div>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => clearSignature(true)}
                  className="flex items-center gap-1.5 min-h-[40px] px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 active:bg-gray-300 transition-colors text-xs font-medium touch-manipulation"
                >
                  <Trash2 className="w-3.5 h-3.5 flex-shrink-0" />
                  Limpiar Firma
                </button>
                {formData.contactSignature && (
                  <div className="flex items-center gap-1.5 text-xs text-green-700">
                    <CheckCircle className="w-3.5 h-3.5" />
                    <span>Firma capturada</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Persona de contacto: formulario en una sola columna */
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
            <h3 className="text-xs sm:text-sm font-semibold text-gray-900">Datos de la Persona de Contacto</h3>
          </div>
          <div className="p-3 sm:p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">{cfg.docLabel} <span className="text-red-600">*</span></label>
                <div className="relative">
                  <input
                    type="text"
                    value={formData.contactDni}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, cfg.docMaxLen);
                      setFormData({ ...formData, contactDni: value, contactName: '' });
                      setContactDniValidated(false);
                    }}
                    onBlur={async () => {
                      if (!cfg.useFactiliza || formData.contactDni.length !== 8) return;
                      setContactDniLoading(true);
                      try {
                        const contactDniTrim = String(formData.contactDni).trim();
                        if (driverDocumentNumber && contactDniTrim === String(driverDocumentNumber).trim()) {
                          toast.error(`El ${cfg.docLabel.toLowerCase()} del contacto no puede ser el mismo que el tuyo`);
                          return;
                        }
                        const { data } = await api.get(`/driver/validate-dni/${formData.contactDni}`);
                        const fullName = data?.data?.fullName;
                        if (fullName) {
                          setFormData((prev: FormData) => ({ ...prev, contactName: fullName }));
                          setContactDniValidated(true);
                        }
                      } catch (err: any) {
                        toast.error(err?.response?.data?.message || 'DNI no encontrado o inválido');
                      } finally {
                        setContactDniLoading(false);
                      }
                    }}
                    placeholder={cfg.docPlaceholder}
                    maxLength={cfg.docMaxLen}
                    className={`w-full min-h-[44px] px-3 py-2 pr-10 border-2 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation ${
                      contactDniError ? 'border-red-500' : contactDniValidated ? 'border-green-500' : 'border-gray-300'
                    }`}
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                    {contactDniLoading && <Loader2 className="w-5 h-5 animate-spin" />}
                    {!contactDniLoading && contactDniValidated && <CheckCircle className="w-5 h-5 text-green-600" />}
                  </div>
                </div>
                {contactDniError ? (
                  <p className="text-xs text-red-600 mt-1">El {cfg.docLabel.toLowerCase()} del contacto no puede ser el mismo que el tuyo</p>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">{cfg.docHint}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Nombre Completo <span className="text-red-600">*</span></label>
                <input
                  type="text"
                  value={formData.contactName}
                  onChange={(e) => !contactDniValidated && setFormData({ ...formData, contactName: e.target.value })}
                  placeholder={cfg.namePlaceholder}
                  disabled={contactDniValidated}
                  className={`w-full min-h-[44px] px-3 py-2 border rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation ${
                    contactDniValidated ? 'border-green-500 bg-green-50/50 text-gray-800 cursor-not-allowed' : 'border-gray-300'
                  }`}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Teléfono <span className="text-red-600">*</span></label>
                <div className={`flex items-center rounded-lg border-2 overflow-hidden min-h-[44px] ${contactPhoneError ? 'border-red-500' : contactPhoneDigits.length === requiredPhoneLen ? 'border-green-500' : 'border-gray-300'}`}>
                  <span className="px-2 sm:px-3 py-2 bg-gray-50 border-r border-gray-300 text-gray-600 text-xs sm:text-sm font-medium flex-shrink-0">{cfg.phonePrefix}</span>
                  <input
                    type="text"
                    value={formData.contactPhone}
                    onChange={(e) => {
                      const value = e.target.value.replace(/\D/g, '').slice(0, cfg.phoneMaxLen);
                      setFormData({ ...formData, contactPhone: value });
                    }}
                    placeholder={cfg.phonePlaceholder}
                    maxLength={cfg.phoneMaxLen}
                    className={`flex-1 min-w-0 px-3 py-2 border-0 focus:ring-2 focus:ring-red-500 focus:outline-none text-sm touch-manipulation ${contactPhoneError ? 'bg-red-50/30' : contactPhoneDigits.length === requiredPhoneLen ? 'bg-green-50/30' : ''}`}
                  />
                </div>
                {contactPhoneError && (
                  <p className="text-[11px] sm:text-xs text-red-600 mt-1">El teléfono del contacto no puede ser el mismo que el tuyo</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-900 mb-1.5">Relación con el Cliente <span className="text-red-600">*</span></label>
                <select
                  value={formData.contactRelationship}
                  onChange={(e) => setFormData({ ...formData, contactRelationship: e.target.value })}
                  className="w-full min-h-[44px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 focus:outline-none text-sm touch-manipulation"
                >
                  <option value="">Selecciona una relación</option>
                  <option value="familiar">Familiar</option>
                  <option value="amigo">Amigo</option>
                  <option value="compañero_trabajo">Compañero de Trabajo</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Paso 5: Plan de Pago según el ciclo del conductor (solo se muestra el plan que corresponde a su ciclo)
function Step5PaymentOptions({ setFormData, loanOptions, loading, driverCycle, requestedAmount, country = 'PE' }: any) {
  const [expandedSchedule, setExpandedSchedule] = useState(false);
  const cycle = Math.max(1, Number(driverCycle) || 1);

  useEffect(() => {
    if (!loading && loanOptions?.option) {
      setFormData((prev: FormData) => ({ ...prev, selectedOption: 1 }));
    }
  }, [loading, loanOptions, setFormData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 sm:py-12">
        <Loader2 className="w-8 h-8 text-red-600 animate-spin" />
      </div>
    );
  }

  if (!loanOptions?.option) {
    return (
      <div className="text-center py-8 sm:py-12">
        <p className="text-xs sm:text-sm text-gray-600">No hay plan disponible. Por favor, completa el paso anterior.</p>
      </div>
    );
  }

  const optionData = loanOptions.option;

  if (!optionData) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-gray-600">No hay plan disponible para tu ciclo.</p>
      </div>
    );
  }

  const option = {
    weeks: optionData.weeks ?? 0,
    data: optionData,
  };
  const schedule = Array.isArray(optionData.schedule) ? optionData.schedule : [];

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header: tu ciclo, tu plan */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">Tu Plan de Pago</h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Según tu ciclo {cycle} – monto y cuotas correspondientes</p>
        </div>
      </div>

      {/* Una sola tarjeta: el plan del ciclo */}
      <div className="bg-white border-2 border-red-600 rounded-lg overflow-hidden bg-red-50/30">
        <div className="p-3 sm:p-4">
          <h3 className="text-xs sm:text-sm font-semibold text-gray-900 mb-2 sm:mb-3">
            Ciclo {cycle} · {option.weeks} semanas
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            <div>
              <p className="text-[11px] sm:text-xs text-gray-600 mb-0.5">Monto solicitado:</p>
              <p className="text-sm sm:text-base font-semibold text-gray-900">{formatCurrency(parseFloat(requestedAmount || '0') || 0, country)}</p>
            </div>
            <div>
              <p className="text-[11px] sm:text-xs text-gray-600 mb-0.5">Cuota semanal:</p>
              <p className="text-sm sm:text-base font-semibold text-gray-900">{formatCurrency(option.data?.weeklyInstallment ?? 0, country)}</p>
            </div>
            <div>
              <p className="text-[11px] sm:text-xs text-gray-600 mb-0.5">Total a pagar:</p>
              <p className="text-sm sm:text-base font-semibold text-gray-900">{formatCurrency(option.data?.totalAmount ?? 0, country)}</p>
            </div>
            <div>
              <p className="text-[11px] sm:text-xs text-gray-600 mb-0.5">Tasa de interés:</p>
              <p className="text-sm sm:text-base font-semibold text-gray-900">{option.data?.interestRate ?? '—'}% semanal</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setExpandedSchedule(!expandedSchedule)}
            className="mt-2 sm:mt-3 min-h-[40px] text-xs sm:text-sm text-red-600 hover:text-red-700 font-medium touch-manipulation flex items-center"
          >
            {expandedSchedule ? 'Ocultar cronograma' : 'Ver cronograma de pagos'}
          </button>
        </div>

        {expandedSchedule && schedule.length > 0 && (
                <div className="border-t border-gray-200 p-3 sm:p-4 bg-gray-50 rounded-b-lg">
                  <h4 className="text-xs sm:text-sm font-semibold text-gray-900 mb-2 sm:mb-3">Cronograma de Pagos</h4>
                  <div className="space-y-2 sm:space-y-2.5 mb-3 sm:mb-4">
                    <div className="flex gap-2 sm:gap-3 p-2.5 sm:p-3 rounded-lg bg-white border border-gray-200/80 shadow-sm">
                      <div className="flex h-7 w-7 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700">
                        <Info className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                      </div>
                      <p className="text-[11px] sm:text-xs text-gray-700 leading-relaxed pt-0.5">
                        Esto es una <strong className="text-gray-900">simulación</strong>: los <strong className="text-gray-900">montos</strong> de cada cuota no cambian; solo las <strong className="text-gray-900">fechas de vencimiento</strong> pueden variar según el día en que se haga el desembolso.
                      </p>
                    </div>
                  </div>
                  <div className="overflow-x-auto -mx-1 sm:mx-0 rounded-lg border border-gray-200 bg-white shadow-sm">
                    <table className="w-full text-[11px] sm:text-xs min-w-[240px]">
                      <thead>
                        <tr className="border-b border-gray-300">
                          <th className="text-left py-1.5 px-1.5 sm:px-2 font-semibold text-gray-700">Cuota</th>
                          <th className="text-left py-1.5 px-1.5 sm:px-2 font-semibold text-gray-700">Fecha Vto.</th>
                          <th className="text-right py-1.5 px-1.5 sm:px-2 font-semibold text-gray-700">Monto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {schedule.map((item: any, idx: number) => (
                          <tr key={item?.installment ?? idx} className="border-b border-gray-200">
                            <td className="py-1.5 px-1.5 sm:px-2">{item?.installment ?? idx + 1}</td>
                            <td className="py-1.5 px-1.5 sm:px-2">
                              {item?.dueDate ? parseLocalDate(item.dueDate).toLocaleDateString('es-PE', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric'
                              }) : '—'}
                            </td>
                            <td className="py-1.5 px-1.5 sm:px-2 text-right font-semibold">{formatCurrency(item?.amount ?? 0, country)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
      </div>
    </div>
  );
}

// Paso 6: Términos y Condiciones
function Step6Terms({ formData, setFormData }: any) {
  const [hasRead, setHasRead] = useState(false);

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">Términos y Condiciones</h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Lee y acepta los términos para continuar</p>
        </div>
      </div>

      {/* Términos */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
          <h3 className="text-xs sm:text-sm font-semibold text-gray-900">Condiciones del Préstamo</h3>
        </div>
        <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
          <div>
            <h4 className="text-[11px] sm:text-xs font-semibold text-gray-900 mb-1.5 sm:mb-2">Proceso de solicitud:</h4>
            <ul className="list-disc list-inside text-[11px] sm:text-xs text-gray-700 space-y-1 leading-relaxed">
              <li>Al enviar este formulario, aceptas estos términos y te comprometes a realizar los pagos a tiempo.</li>
              <li>YEGO se reserva el derecho de aprobar o rechazar el préstamo sin necesidad de dar explicaciones.</li>
              <li>YEGO comunicará la decisión (confirmación o denegación) en un máximo de 48 horas después de completar el formulario.</li>
            </ul>
          </div>

          <div>
            <h4 className="text-[11px] sm:text-xs font-semibold text-gray-900 mb-1.5 sm:mb-2">Condiciones de pago:</h4>
            <ul className="list-disc list-inside text-[11px] sm:text-xs text-gray-700 space-y-1 leading-relaxed">
              <li>El conductor se compromete a depositar las cuotas semanales cada lunes.</li>
              <li>YEGO ofrece la comodidad de descontar el pago directamente del saldo positivo del conductor el mismo lunes.</li>
              <li>El incumplimiento del pago resultará en la pérdida automática de beneficios en ciclos futuros.</li>
              <li>Si el margen de pago a tiempo en cualquier ciclo es deficiente, el conductor será regresado al ciclo 1 y deberá cumplir nuevamente los requisitos para acceder a ciclos superiores.</li>
            </ul>
          </div>

          <div>
            <h4 className="text-[11px] sm:text-xs font-semibold text-gray-900 mb-1.5 sm:mb-2">Condiciones generales:</h4>
            <ul className="list-disc list-inside text-[11px] sm:text-xs text-gray-700 space-y-1 leading-relaxed">
              <li>Los préstamos son personales e intransferibles.</li>
              <li>El incumplimiento del pago puede impedir el acceso a ciclos futuros y otros beneficios Premium.</li>
              <li>YEGO puede aplicar medidas como la suspensión de beneficios en caso de morosidad reiterada.</li>
              <li>El beneficio está sujeto a la participación activa del conductor en el programa "YEGO Yego Premium Oro".</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Aceptación */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div className="flex items-start gap-2 sm:gap-3">
          <input
            type="checkbox"
            id="terms"
            checked={formData.termsAccepted}
            onChange={(e) => {
              setFormData({ ...formData, termsAccepted: e.target.checked });
              if (e.target.checked) {
                setHasRead(true);
              }
            }}
            className="w-5 h-5 sm:w-4 sm:h-4 text-red-600 border-gray-300 rounded focus:ring-red-500 mt-0.5 flex-shrink-0 touch-manipulation"
          />
          <label htmlFor="terms" className="text-xs sm:text-sm text-gray-700 cursor-pointer leading-relaxed touch-manipulation py-0.5">
            Acepto los Términos y Condiciones de Rapidín
          </label>
        </div>
        {hasRead && !formData.termsAccepted && (
          <p className="text-xs text-gray-600 mt-2 flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5 text-green-600" />
            Has leído los términos. Ahora puedes aceptarlos.
          </p>
        )}
      </div>
    </div>
  );
}

// Paso 7: Firma y Documento
function Step7Signature({ formData, setFormData, signatureRef, clearSignature, handleSignatureStart, handleSignatureMove, handleSignatureEnd }: any) {
  const [showCamera, setShowCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const idDocumentFileInputRef = useRef<HTMLInputElement>(null);

  // Restaurar la firma en el canvas si existe
  useEffect(() => {
    if (formData.contractSignature && signatureRef.current) {
      const canvas = signatureRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
        img.src = formData.contractSignature;
      }
    }
  }, [formData.contractSignature]);

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setCameraError(null);
  };

  const openCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      setShowCamera(true);
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 0);
    } catch (err: any) {
      setCameraError(err?.message || 'No se pudo acceder a la cámara. Revisa los permisos.');
      toast.error('No se pudo abrir la cámara');
    }
  };

  const closeCamera = () => {
    stopStream();
    setShowCamera(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  useEffect(() => {
    if (!showCamera) return;
    return () => { stopStream(); };
  }, [showCamera]);

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = captureCanvasRef.current;
    if (!video || !canvas || !streamRef.current) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], 'dni-frontal.jpg', { type: 'image/jpeg' });
        setFormData({ ...formData, idDocument: file });
        closeCamera();
        toast.success('Foto capturada correctamente');
      },
      'image/jpeg',
      0.9
    );
  };

  const onIdDocumentFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setFormData({ ...formData, idDocument: file });
      toast.success('Documento cargado');
    }
    e.target.value = '';
  };

  // En dev: "Adjuntar foto" (selector de archivo). En producción: "Tomar foto" (cámara).
  const allowFileUpload = (import.meta as { env?: { DEV?: boolean; VITE_ALLOW_FILE_UPLOAD?: string } }).env?.VITE_ALLOW_FILE_UPLOAD === 'true' || (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-3 sm:p-4">
        <div>
          <h2 className="text-base sm:text-xl font-semibold text-gray-900">Firma del Contrato y Foto de Documento</h2>
          <p className="text-[11px] sm:text-xs text-gray-600 mt-0.5">Firma el contrato y toma una foto de la parte frontal de tu documento de identidad</p>
        </div>
      </div>

      {/* Una fila: primero Foto de documento, luego Firma del contrato */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        {/* 1. Foto de Documento de Identidad (parte frontal) */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
            <h3 className="text-xs sm:text-sm font-semibold text-gray-900">1. Foto de Documento (parte frontal)</h3>
          </div>
          <div className="p-3 sm:p-4 space-y-2 sm:space-y-3">
            <p className="text-[11px] sm:text-xs text-gray-600">
              Toma una foto de la <strong>parte frontal</strong> de tu documento de identidad (DNI, cédula, etc.)
            </p>

            {formData.idDocument ? (
              <div className="space-y-2 sm:space-y-3">
                <div className="border border-gray-300 rounded-lg p-2.5 sm:p-3 bg-gray-50">
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <p className="text-[11px] sm:text-xs font-medium text-gray-900 truncate flex-1 min-w-0">{formData.idDocument.name}</p>
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, idDocument: null })}
                      className="text-xs text-red-600 hover:text-red-700 underline flex-shrink-0 touch-manipulation py-1"
                    >
                      Eliminar
                    </button>
                  </div>
                  {formData.idDocument.type.startsWith('image/') && (
                    <img
                      src={URL.createObjectURL(formData.idDocument)}
                      alt="Documento"
                      className="w-full max-h-36 sm:max-h-48 object-contain rounded border border-gray-200"
                    />
                  )}
                </div>
                <p className="text-[11px] sm:text-xs text-green-600 flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  Documento cargado correctamente
                </p>
              </div>
            ) : (
              <div>
                <input
                  ref={idDocumentFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onIdDocumentFileChange}
                />
                {allowFileUpload ? (
                  <button
                    type="button"
                    onClick={() => idDocumentFileInputRef.current?.click()}
                    className="w-full sm:w-auto min-h-[44px] min-w-[140px] px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 active:bg-red-800 transition-colors touch-manipulation"
                  >
                    Adjuntar foto
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={openCamera}
                    className="w-full sm:w-auto min-h-[44px] min-w-[140px] px-4 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 active:bg-red-800 transition-colors touch-manipulation"
                  >
                    Tomar foto (parte frontal)
                  </button>
                )}
                {cameraError && (
                  <p className="text-[11px] sm:text-xs text-red-600 mt-2">{cameraError}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 2. Firma del Contrato */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="border-b border-gray-200 px-3 sm:px-4 py-2.5 sm:py-3">
            <h3 className="text-xs sm:text-sm font-semibold text-gray-900">2. Firma del Contrato</h3>
          </div>
          <div className="p-3 sm:p-4 space-y-2 sm:space-y-3">
            <p className="text-[11px] sm:text-xs text-gray-600">
              Firma en el recuadro usando tu dedo o mouse.
            </p>
            <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
              <canvas
                ref={signatureRef}
                width={600}
                height={200}
                style={{ width: '100%', maxWidth: '100%', height: 'clamp(160px, 35vw, 200px)', cursor: 'crosshair', touchAction: 'none' }}
                onMouseDown={handleSignatureStart}
                onMouseMove={handleSignatureMove}
                onMouseUp={handleSignatureEnd}
                onMouseLeave={handleSignatureEnd}
                onTouchStart={handleSignatureStart}
                onTouchMove={handleSignatureMove}
                onTouchEnd={handleSignatureEnd}
              />
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => clearSignature(false)}
                className="min-h-[40px] text-[11px] sm:text-xs text-gray-600 hover:text-gray-800 underline touch-manipulation py-1"
              >
                Limpiar Firma
              </button>
              {formData.contractSignature && (
                <p className="text-[11px] sm:text-xs text-green-600 flex items-center gap-1.5">
                  <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  Firma capturada
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Modal cámara: solo cámara, con marco para encajar el DNI */}
      {showCamera && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center p-3 sm:p-4 pointer-events-none">
            <div
              className="w-full max-w-[260px] sm:max-w-[280px] aspect-[1.58] border-4 border-dashed border-white rounded-lg bg-transparent"
              style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
            />
            <p className="text-white text-center text-xs sm:text-sm font-semibold drop-shadow-md mt-3 sm:mt-4 px-4">
              Encaja el DNI dentro del marco
            </p>
          </div>
          <div className="absolute bottom-0 left-0 right-0 p-3 sm:p-4 flex gap-2 sm:gap-3 justify-center bg-gradient-to-t from-black/80 to-transparent">
            <button
              type="button"
              onClick={closeCamera}
              className="flex items-center justify-center gap-2 min-h-[44px] px-4 sm:px-5 py-2.5 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-500 touch-manipulation"
            >
              <X className="w-4 h-4 flex-shrink-0" />
              Cancelar
            </button>
            <button
              type="button"
              onClick={capturePhoto}
              className="flex items-center justify-center gap-2 min-h-[44px] px-4 sm:px-5 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 touch-manipulation"
            >
              <Camera className="w-4 h-4 flex-shrink-0" />
              Capturar
            </button>
          </div>
          <canvas ref={captureCanvasRef} className="hidden" />
        </div>
      )}
    </div>
  );
}

export default LoanRequestFlow;
