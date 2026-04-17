import { Search } from 'lucide-react';

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** UUID / ID de préstamo */
  mono?: boolean;
  className?: string;
};

/**
 * Campo de búsqueda unificado Rapidín: icono, foco rojo, texto de ayuda (búsqueda al dejar de escribir).
 */
export function RapidinSearchField({
  id,
  label,
  value,
  onChange,
  placeholder,
  mono = false,
  className = '',
}: Props) {
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-xs font-semibold text-gray-900 mb-1.5">
        {label}
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" aria-hidden />
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className={`w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-600 outline-none text-sm shadow-sm transition-shadow ${mono ? 'font-mono' : ''}`}
        />
      </div>
      <p className="mt-1 text-[11px] text-gray-500">La búsqueda se aplica al dejar de escribir</p>
    </div>
  );
}
