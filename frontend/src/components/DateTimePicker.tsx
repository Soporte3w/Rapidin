import { useState, useRef, useEffect } from 'react';
import {
  format,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  startOfDay,
  isBefore,
} from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar, ChevronDown, Clock } from 'lucide-react';

const WEEK_STARTS_ON = 1; // Lunes

export interface DateTimePickerProps {
  label?: string;
  value: string; // 'YYYY-MM-DDTHH:mm' o ''
  onChange: (value: string) => void;
  minDate?: string; // 'YYYY-MM-DD'
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

function toYYYYMMDD(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function getCurrentTimeHHMM(): string {
  return format(new Date(), 'HH:mm');
}

/** true si a < b en formato HH:mm */
function isTimeBefore(a: string, b: string): boolean {
  if (!a || !b) return false;
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return ah < bh || (ah === bh && am < bm);
}

function parseValue(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '09:00' };
  const [datePart, timePart] = value.split('T');
  return {
    date: datePart || '',
    time: timePart ? timePart.slice(0, 5) : '09:00',
  };
}

/** Convierte HH:mm a formato 12 h (ej. "14:30" → "2:30 p. m."). */
function formatTime12h(timeStr: string, locale = 'es-ES'): string {
  if (!timeStr || timeStr.length < 5) return '';
  const [h, m] = timeStr.slice(0, 5).split(':').map(Number);
  const d = new Date(2000, 0, 1, h ?? 0, m ?? 0);
  return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDisplay(dateStr: string, timeStr: string, locale = 'es-ES'): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  const dateFormatted = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  if (!timeStr || timeStr === '09:00') return dateFormatted;
  return `${dateFormatted}, ${formatTime12h(timeStr, locale)}`;
}

export function DateTimePicker({
  label = 'Fecha y hora',
  value,
  onChange,
  minDate,
  placeholder = 'Elegir fecha y hora',
  className = '',
  inputClassName = '',
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const { date: valueDate, time: valueTime } = parseValue(value);
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    if (valueDate) return startOfMonth(new Date(valueDate + 'T12:00:00'));
    return startOfMonth(new Date());
  });
  const [tempDate, setTempDate] = useState<string>(valueDate);
  const [tempTime, setTempTime] = useState<string>(valueTime);
  const boxRef = useRef<HTMLDivElement>(null);

  const minD = minDate ? startOfDay(new Date(minDate + 'T12:00:00')) : null;

  useEffect(() => {
    if (!open) return;
    if (valueDate) setViewMonth(startOfMonth(new Date(valueDate + 'T12:00:00')));
    else setViewMonth(startOfMonth(new Date()));
    const todayStr = toYYYYMMDD(new Date());
    const nowTime = getCurrentTimeHHMM();
    if (valueDate === todayStr && isTimeBefore(valueTime, nowTime)) {
      setTempDate(valueDate);
      setTempTime(nowTime);
      onChange(`${valueDate}T${nowTime}:00`);
    } else {
      setTempDate(valueDate);
      setTempTime(valueTime);
    }
  }, [open, valueDate, valueTime]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const todayStr = toYYYYMMDD(new Date());
  const minTimeForToday = tempDate === todayStr ? getCurrentTimeHHMM() : undefined;

  const emitChange = (date: string, time: string) => {
    if (!date) {
      onChange('');
      return;
    }
    let timeNorm = time || '09:00';
    if (date === todayStr && minTimeForToday && isTimeBefore(timeNorm, minTimeForToday)) {
      timeNorm = minTimeForToday;
    }
    onChange(`${date}T${timeNorm.length === 5 ? timeNorm + ':00' : timeNorm}`);
  };

  const handleDayClick = (day: Date) => {
    const dayStart = startOfDay(day);
    if (minD && isBefore(dayStart, minD)) return;
    const dateStr = toYYYYMMDD(dayStart);
    const isToday = dateStr === todayStr;
    let timeToUse = tempTime;
    if (isToday && minTimeForToday && isTimeBefore(tempTime, minTimeForToday)) {
      timeToUse = minTimeForToday;
      setTempTime(timeToUse);
    }
    setTempDate(dateStr);
    emitChange(dateStr, timeToUse);
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = e.target.value;
    setTempTime(t);
    emitChange(tempDate, t);
  };

  const displayText = valueDate ? formatDisplay(valueDate, valueTime) : placeholder;

  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(viewMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: WEEK_STARTS_ON });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: WEEK_STARTS_ON });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const selectedDate = tempDate ? new Date(tempDate + 'T12:00:00') : null;
  const weekDays = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  return (
    <div className={`relative ${className}`} ref={boxRef}>
      {label && (
        <label className="block text-xs font-semibold text-gray-900 mb-1.5">{label}</label>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white text-left text-sm focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none ${inputClassName}`}
      >
        <Calendar className="w-4 h-4 text-gray-500 flex-shrink-0" />
        <span className={valueDate ? 'text-gray-900' : 'text-gray-500'}>{displayText}</span>
        <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-[100] bg-white border border-gray-200 rounded-lg shadow-lg p-4 min-w-[280px]">
          <div className="flex items-center justify-between mb-3">
            <button
              type="button"
              onClick={() => setViewMonth((m) => subMonths(m, 1))}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-600"
              aria-label="Mes anterior"
            >
              ←
            </button>
            <span className="text-sm font-semibold text-gray-900 capitalize">
              {format(viewMonth, 'MMM yyyy', { locale: es })}
            </span>
            <button
              type="button"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-600"
              aria-label="Mes siguiente"
            >
              →
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-3">
            {weekDays.map((d, i) => (
              <div key={i} className="text-center text-xs font-medium text-gray-500 py-1">
                {d}
              </div>
            ))}
            {days.map((day) => {
              const inMonth = isSameMonth(day, viewMonth);
              const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
              const isDisabled = minD ? isBefore(startOfDay(day), minD) : false;

              return (
                <button
                  key={day.getTime()}
                  type="button"
                  onClick={() => handleDayClick(day)}
                  disabled={isDisabled}
                  className={`
                    w-8 h-8 rounded-full text-sm
                    ${!inMonth ? 'text-gray-300' : 'text-gray-900'}
                    ${isDisabled && inMonth ? 'opacity-50 cursor-not-allowed' : ''}
                    ${isSelected ? 'bg-[#8B1A1A] text-white hover:bg-[#6B1515]' : inMonth && !isDisabled ? 'hover:bg-red-50' : ''}
                  `}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>

          <div className="border-t border-gray-100 pt-3 flex items-center gap-2">
            <Clock className="w-4 h-4 text-gray-500 flex-shrink-0" />
            <label className="text-sm font-medium text-gray-700 flex-shrink-0">Hora</label>
            <input
              type="time"
              value={tempTime}
              min={minTimeForToday}
              onChange={handleTimeChange}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
