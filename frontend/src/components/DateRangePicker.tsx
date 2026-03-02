import { useState, useRef, useEffect } from 'react';
import {
  format,
  addMonths,
  subMonths,
  addDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  subWeeks,
  eachDayOfInterval,
  isSameMonth,
  isWithinInterval,
  isSameDay,
  startOfDay,
  isBefore,
} from 'date-fns';
import { es } from 'date-fns/locale';
import { Calendar, ChevronDown } from 'lucide-react';

const WEEK_STARTS_ON = 1; // Lunes

type DateRange = { date_from: string; date_to: string };

interface DateRangePickerProps {
  label?: string;
  value: DateRange;
  onChange: (range: DateRange) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

function toYYYYMMDD(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

function formatRangeDisplay(date_from: string, date_to: string, locale: string = 'es-PE'): string {
  if (!date_from && !date_to) return '';
  if (date_from && !date_to) return new Date(date_from + 'T12:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  if (!date_from && date_to) return new Date(date_to + 'T12:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const from = new Date(date_from + 'T12:00:00');
  const to = new Date(date_to + 'T12:00:00');
  if (isSameDay(from, to)) return from.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${from.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} - ${to.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function DateRangePicker({ label = 'Fecha', value, onChange, placeholder = 'Filtrar por fecha', className = '', inputClassName = '' }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    if (value.date_from) return startOfMonth(new Date(value.date_from + 'T12:00:00'));
    if (value.date_to) return startOfMonth(new Date(value.date_to + 'T12:00:00'));
    return startOfMonth(new Date());
  });
  const [tempStart, setTempStart] = useState<Date | null>(null);
  const [tempEnd, setTempEnd] = useState<Date | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (value.date_from) setViewMonth(startOfMonth(new Date(value.date_from + 'T12:00:00')));
    else if (value.date_to) setViewMonth(startOfMonth(new Date(value.date_to + 'T12:00:00')));
    else setViewMonth(startOfMonth(new Date()));
    setTempStart(value.date_from ? new Date(value.date_from + 'T12:00:00') : null);
    setTempEnd(value.date_to ? new Date(value.date_to + 'T12:00:00') : null);
  }, [open, value.date_from, value.date_to]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const displayText = formatRangeDisplay(value.date_from, value.date_to) || placeholder;

  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(viewMonth);
  const calStart = startOfWeek(monthStart, { weekStartsOn: WEEK_STARTS_ON });
  const calEnd = endOfWeek(monthEnd, { weekStartsOn: WEEK_STARTS_ON });
  const days = eachDayOfInterval({ start: calStart, end: calEnd });

  const startD = tempStart ?? (value.date_from ? new Date(value.date_from + 'T12:00:00') : null);
  const endD = tempEnd ?? (value.date_to ? new Date(value.date_to + 'T12:00:00') : null);

  const applyRange = (from: Date, to: Date) => {
    const d1 = isBefore(from, to) ? from : to;
    const d2 = isBefore(from, to) ? to : from;
    onChange({ date_from: toYYYYMMDD(d1), date_to: toYYYYMMDD(d2) });
    setOpen(false);
  };

  const handleDayClick = (day: Date) => {
    const dayStart = startOfDay(day);
    if (!startD) {
      setTempStart(dayStart);
      setTempEnd(dayStart);
    } else if (endD && isSameDay(startD, endD)) {
      applyRange(startD, dayStart);
      return;
    } else {
      setTempStart(dayStart);
      setTempEnd(dayStart);
    }
  };

  const handleQuick = (from: Date, to: Date) => {
    onChange({ date_from: toYYYYMMDD(from), date_to: toYYYYMMDD(to) });
    setOpen(false);
  };

  const today = startOfDay(new Date());
  // Semana: lunes 00:00 a domingo 00:00 (usar mismo día para date_to para que el backend incluya el domingo)
  const thisWeekStart = startOfWeek(today, { weekStartsOn: WEEK_STARTS_ON });
  const thisWeekEnd = startOfDay(addDays(thisWeekStart, 6)); // domingo a 00:00
  const lastWeekStart = startOfWeek(subWeeks(today, 1), { weekStartsOn: WEEK_STARTS_ON });
  const lastWeekEnd = startOfDay(addDays(lastWeekStart, 6));
  const thisMonthStart = startOfMonth(today);
  const thisMonthEnd = endOfMonth(today);
  const lastMonthStart = startOfMonth(subMonths(today, 1));
  const lastMonthEnd = endOfMonth(subMonths(today, 1));

  const weekDays = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  return (
    <div className={`relative ${className}`} ref={boxRef}>
      {label && (
        <label className="block text-xs font-semibold text-gray-900 mb-1.5">
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white text-left text-sm focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none ${inputClassName}`}
      >
        <Calendar className="w-4 h-4 text-gray-500 flex-shrink-0" />
        <span className={value.date_from || value.date_to ? 'text-gray-900' : 'text-gray-500'}>
          {displayText}
        </span>
        <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-4 min-w-[280px]">
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
              const isStart = startD && isSameDay(day, startD);
              const isEnd = endD && isSameDay(day, endD);
              const inRange =
                startD && endD &&
                isWithinInterval(day, { start: startD, end: endD });
              const isSelected = isStart || isEnd || (inRange && !isStart && !isEnd);

              return (
                <button
                  key={day.getTime()}
                  type="button"
                  onClick={() => handleDayClick(day)}
                  className={`
                    w-8 h-8 rounded-full text-sm
                    ${!inMonth ? 'text-gray-300' : 'text-gray-900'}
                    ${isSelected ? 'bg-[#8B1A1A] text-white hover:bg-[#6B1515]' : inMonth ? 'hover:bg-red-50' : ''}
                  `}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={() => handleQuick(thisWeekStart, thisWeekEnd)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Esta semana
            </button>
            <button
              type="button"
              onClick={() => handleQuick(lastWeekStart, lastWeekEnd)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              La semana pasada
            </button>
            <button
              type="button"
              onClick={() => handleQuick(thisMonthStart, thisMonthEnd)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Este mes
            </button>
            <button
              type="button"
              onClick={() => handleQuick(lastMonthStart, lastMonthEnd)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              El mes pasado
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
