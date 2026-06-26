import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import DriverSidebar from './DriverSidebar';
import DriverHeader from './DriverHeader';
import DriverBottomNav from './DriverBottomNav';

export default function DriverLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      <DriverSidebar 
        isOpen={sidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />

      {/* Main content - padding según ancho del sidebar en desktop */}
      <div className="lg:pl-72">
        <DriverHeader onMenuClick={() => setSidebarOpen(true)} />

        {/* Page content - pb-20 para bottom nav en móvil */}
        <main className="p-3 sm:p-4 lg:p-8 min-h-screen pb-20 lg:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Bottom navigation - solo móvil */}
      <DriverBottomNav />
    </div>
  );
}




