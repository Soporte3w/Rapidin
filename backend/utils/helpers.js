export const formatCurrency = (amount, country) => {
  const formatter = new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: country === 'PE' ? 'PEN' : 'COP',
    minimumFractionDigits: 2
  });
  return formatter.format(amount);
};

export const calculateDaysBetween = (startDate, endDate) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const difference = end - start;
  return Math.floor(difference / (1000 * 60 * 60 * 24));
};

export const getFirstMonday = (startDate, waitDays) => {
  const date = new Date(startDate);
  date.setDate(date.getDate() + waitDays);
  
  while (date.getDay() !== 1) {
    date.setDate(date.getDate() + 1);
  }
  
  return date;
};

/**
 * Fecha de la primera cuota (siempre un LUNES) según día del desembolso.
 * En el sistema no se desembolsa los domingos (restricción en loanService); si aun así se recibe domingo, primera cuota = lunes siguiente.
 * - Lun–Jue: primer cobro el lunes de la semana siguiente.
 * - Vie–Sáb: primer cobro el lunes de la semana siguiente (no el inmediato).
 */
export const getNextMondayFrom = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=dom, 1=lun, ..., 6=sáb
  let daysToAdd;
  if (day === 0) {
    daysToAdd = 1; // domingo (no se desembolsa; por consistencia: lunes siguiente)
  } else if (day >= 1 && day <= 4) {
    // lun–jue → próximo lunes (mismo lunes si es lunes = +7)
    daysToAdd = day === 1 ? 7 : (8 - day);
  } else {
    // vie(5)–sáb(6) → lunes de la semana siguiente (no el inmediato)
    daysToAdd = (8 - day) + 7; // 5→10, 6→9
  }
  d.setDate(d.getDate() + daysToAdd);
  return d;
};

/** Devuelve true si la fecha es domingo (no se puede desembolsar). */
export const isSunday = (date) => new Date(date).getDay() === 0;

export const validateDNIPeru = (dni) => {
  return /^\d{8}$/.test(dni);
};

export const validateDNIColombia = (dni) => {
  return /^\d{10}$/.test(dni);
};

export const validateDNI = (dni, country) => {
  if (country === 'PE') {
    return validateDNIPeru(dni);
  } else if (country === 'CO') {
    return validateDNIColombia(dni);
  }
  return false;
};

export const sanitizeText = (text) => {
  if (!text) return '';
  return text.trim().replace(/[<>]/g, '');
};

/** Normaliza teléfono para consultas (PE: +51…, CO: +57…). */
export const normalizePhoneForDb = (phone, country) => {
  const digits = (phone || '').toString().replace(/\D/g, '');
  if (country === 'CO') {
    return digits.length === 12 && digits.startsWith('57') ? `+${digits}` : `+57${digits}`;
  }
  return digits.length === 11 && digits.startsWith('51') ? `+${digits}` : digits.length >= 9 ? `+51${digits.slice(-9)}` : `+${digits}`;
};

/** Código país para tabla drivers (license_country): PE -> per, CO -> col. */
export const getCountryCodeForDrivers = (country) => {
  return country === 'PE' ? 'per' : country === 'CO' ? 'col' : (country || '').toLowerCase();
};







