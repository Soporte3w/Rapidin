import { ShieldCheck } from 'lucide-react';
import UsersManagement from '../yegoRapidin/settings/UsersManagement';

export default function SystemUsersPage() {
  return (
    <div className="space-y-4 lg:space-y-6">
      <header className="bg-[#8B1A1A] rounded-lg p-4 lg:p-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#6B1515] rounded-lg flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-white leading-tight">Usuarios y permisos</h1>
            <p className="text-xs lg:text-sm text-white/90 mt-0.5">
              Gestión de accesos del sistema financiador
            </p>
          </div>
        </div>
      </header>

      <UsersManagement standalone />
    </div>
  );
}
