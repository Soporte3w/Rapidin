import { formatMimotoMoney, type MimotoCurrency } from './mimotoApi';

export const MIMOTO_FIELD_CLASS = 'h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition focus:border-red-500 focus:ring-2 focus:ring-red-100 disabled:cursor-default disabled:bg-gray-50';

export function sanitizeMimotoMoneyInput(value: string, currency: MimotoCurrency) {
  if (currency === 'COP') return value.replace(/\D/g, '');
  const normalized = value.replace(',', '.').replace(/[^\d.]/g, '');
  const [integer = '', ...decimals] = normalized.split('.');
  return decimals.length > 0 ? `${integer}.${decimals.join('').slice(0, 2)}` : integer;
}

export function formatMimotoMoneyInput(value: string, currency: MimotoCurrency) {
  if (!value || currency === 'USD') return value;
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

export default function MimotoMoneyField({ value, currency, disabled, onChange, ariaLabel }: {
  value: string;
  currency: MimotoCurrency;
  disabled: boolean;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  if (disabled) {
    return (
      <div className="flex h-10 min-w-[150px] items-center justify-end rounded-lg border border-gray-200 bg-gray-50 px-3 text-sm font-semibold text-gray-800">
        {formatMimotoMoney(value, currency)}
      </div>
    );
  }

  return (
    <div className="flex h-10 min-w-[150px] items-center overflow-hidden rounded-lg border border-gray-300 bg-white focus-within:border-red-500 focus-within:ring-2 focus-within:ring-red-100">
      <span className="shrink-0 border-r border-gray-200 bg-gray-50 px-2.5 py-2 text-xs font-semibold text-gray-600">
        {currency === 'COP' ? '$' : 'US$'}
      </span>
      <input
        type="text"
        inputMode={currency === 'COP' ? 'numeric' : 'decimal'}
        value={formatMimotoMoneyInput(value, currency)}
        onChange={(event) => onChange(sanitizeMimotoMoneyInput(event.target.value, currency))}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 border-0 bg-transparent px-2.5 text-right text-sm text-gray-900 outline-none ring-0"
        placeholder="0"
      />
    </div>
  );
}
