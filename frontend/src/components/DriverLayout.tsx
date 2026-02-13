import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import DriverSidebar from './DriverSidebar';
import DriverHeader from './DriverHeader';

export default function DriverLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50">
      <DriverSidebar 
        isOpen={sidebarOpen} 
        onClose={() => setSidebarOpen(false)} 
      />

      {/* Main content */}
      <div className="lg:pl-64">
        <DriverHeader onMenuClick={() => setSidebarOpen(true)} />

        {/* Page content */}
        <main className="p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}




