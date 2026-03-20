import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Home from './pages/public/Home';
import LandingPage from './pages/public/LandingPage';
import LoanRequestPE from './pages/public/LoanRequestPE';
import LoanRequestCO from './pages/public/LoanRequestCO';
import GuarantorSignaturePublic from './pages/public/GuarantorSignaturePublic';
import Login from './pages/public/Login';
import Dashboard from './pages/yegoRapidin/Dashboard';
import LoanRequests from './pages/yegoRapidin/LoanRequests';
import LoanRequestDetail from './pages/yegoRapidin/LoanRequestDetail';
import Loans from './pages/yegoRapidin/Loans';
import LoanDetail from './pages/yegoRapidin/LoanDetail';
import Payments from './pages/yegoRapidin/Payments';
import Analysis from './pages/yegoRapidin/Analysis';
import Settings from './pages/yegoRapidin/Settings';
import Provisions from './pages/yegoRapidin/Provisions';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import DriverLayout from './components/DriverLayout';
import DriverDashboard from './pages/driver/DriverDashboard';
import DriverLoans from './pages/driver/DriverLoans';
import DriverNewLoan from './pages/driver/DriverNewLoan';
import DriverProfile from './pages/driver/DriverProfile';
import DriverVouchers from './pages/driver/DriverVouchers';
import LoanBenefits from './pages/driver/LoanBenefits';
import LoanOfferVerification from './pages/driver/LoanOfferVerification';
import LoanRequestFlow from './pages/driver/LoanRequestFlow';
import QuieroMiYegoAuto from './pages/driver/QuieroMiYegoAuto';
import { DRIVER_MI_AUTO_ENABLED } from './components/DriverSidebar';
import SelectFlota from './pages/driver/SelectFlota';
import NewLoanRequest from './pages/yegoRapidin/NewLoanRequest';
import YegoMiAutoDashboard from './pages/yegoMiAuto/YegoMiAutoDashboard';
import YegoMiAutoFlotas from './pages/yegoMiAuto/YegoMiAutoFlotas';
import YegoMiAutoConfig from './pages/yegoMiAuto/YegoMiAutoConfig';
import YegoMiAutoAnalysis from './pages/yegoMiAuto/YegoMiAutoAnalysis';
import YegoMiAutoPayments from './pages/yegoMiAuto/YegoMiAutoPayments';
import YegoMiAutoLoans from './pages/yegoMiAuto/YegoMiAutoLoans';
import YegoMiAutoRentSaleDetail from './pages/yegoMiAuto/YegoMiAutoRentSaleDetail';
import YegoMiAutoNewRequest from './pages/yegoMiAuto/YegoMiAutoNewRequest';
import YegoMiAutoSolicitudes from './pages/yegoMiAuto/YegoMiAutoSolicitudes';
import YegoMiAutoSolicitudDetail from './pages/yegoMiAuto/YegoMiAutoSolicitudDetail';
import YegoMiMotoDashboard from './pages/yegoMiMoto/YegoMiMotoDashboard';
import YegoMiMotoFlotas from './pages/yegoMiMoto/YegoMiMotoFlotas';
import YegoMiMotoConfig from './pages/yegoMiMoto/YegoMiMotoConfig';
import YegoMiMotoAnalysis from './pages/yegoMiMoto/YegoMiMotoAnalysis';
import YegoMiMotoPayments from './pages/yegoMiMoto/YegoMiMotoPayments';
import YegoMiMotoLoans from './pages/yegoMiMoto/YegoMiMotoLoans';
import YegoMiMotoNewRequest from './pages/yegoMiMoto/YegoMiMotoNewRequest';
import { AuthProvider } from './contexts/AuthContext';

function RedirectSolicitudToRequest() {
  const { id } = useParams();
  return <Navigate to={`/admin/yego-mi-auto/requests/${id}`} replace />;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#fff',
              color: '#1f2937',
              border: '1px solid #e5e7eb',
              borderRadius: '0.5rem',
              boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
            },
            error: {
              iconTheme: {
                primary: '#ef4444',
                secondary: '#fff',
              },
              style: {
                border: '1px solid #fecaca',
                background: '#fef2f2',
              },
            },
          }}
        />
        <Routes>
            {/* Public routes */}
            <Route path="/" element={<Home />} />
            <Route path="/driver/login" element={<LandingPage />} />
            <Route path="/admin/login" element={<Login />} />
            {/* Redirect old /login to /driver/login */}
            <Route path="/login" element={<Navigate to="/driver/login" replace />} />
            <Route path="/request/pe" element={<LoanRequestPE />} />
            <Route path="/request/co" element={<LoanRequestCO />} />
            <Route path="/guarantor-signature/:token" element={<GuarantorSignaturePublic />} />
            
            {/* Vista bloqueante: solo elegir flota (sin layout), luego redirige a resumen */}
            <Route
              path="/driver/seleccionar-flota"
              element={
                <ProtectedRoute>
                  <SelectFlota />
                </ProtectedRoute>
              }
            />
            {/* Driver routes (con sidebar/header) */}
            <Route
              path="/driver"
              element={
                <ProtectedRoute>
                  <DriverLayout />
                </ProtectedRoute>
              }
            >
              <Route index element={<Navigate to="resumen" replace />} />
              <Route path="resumen" element={<DriverDashboard />} />
              <Route path="loans" element={<DriverLoans />} />
              <Route path="loans/:loanId/vouchers" element={<DriverVouchers />} />
              <Route path="vouchers" element={<DriverVouchers />} />
              <Route path="new-loan" element={<DriverNewLoan />} />
              <Route path="loan-benefits" element={<LoanBenefits />} />
              <Route path="loan-offer-verification" element={<LoanOfferVerification />} />
              <Route path="loan-request-flow" element={<LoanRequestFlow />} />
              <Route path="quiero-mi-auto" element={DRIVER_MI_AUTO_ENABLED ? <QuieroMiYegoAuto /> : <Navigate to="/driver/resumen" replace />} />
              <Route path="profile" element={<DriverProfile />} />
            </Route>
            
            {/* Admin routes: redirect /admin a dashboard */}
            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route
              path="/admin/dashboard"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Dashboard />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loan-requests"
              element={
                <ProtectedRoute>
                  <Layout>
                    <LoanRequests />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loan-requests/new"
              element={
                <ProtectedRoute>
                  <Layout>
                    <NewLoanRequest />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loan-requests/:id"
              element={
                <ProtectedRoute>
                  <Layout>
                    <LoanRequestDetail />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loans"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Loans />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loans/:id"
              element={
                <ProtectedRoute>
                  <Layout>
                    <LoanDetail />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/payments"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Payments />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/analysis"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Analysis />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/settings"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Settings />
                  </Layout>
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/provisions"
              element={
                <ProtectedRoute>
                  <Layout>
                    <Provisions />
                  </Layout>
                </ProtectedRoute>
              }
            />
            {/* Yego mi auto (mismo Layout, menú distinto según ruta) */}
            <Route path="/admin/yego-mi-auto" element={<Navigate to="/admin/yego-mi-auto/dashboard" replace />} />
            <Route path="/admin/yego-mi-auto/dashboard" element={<ProtectedRoute><Layout><YegoMiAutoDashboard /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/flotas" element={<ProtectedRoute><Layout><YegoMiAutoFlotas /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/requests" element={<ProtectedRoute><Layout><YegoMiAutoSolicitudes /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/requests/:id" element={<ProtectedRoute><Layout><YegoMiAutoSolicitudDetail /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/solicitudes" element={<Navigate to="/admin/yego-mi-auto/requests" replace />} />
            <Route path="/admin/yego-mi-auto/solicitudes/:id" element={<RedirectSolicitudToRequest />} />
            <Route path="/admin/yego-mi-auto/config" element={<ProtectedRoute><Layout><YegoMiAutoConfig /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/analysis" element={<ProtectedRoute><Layout><YegoMiAutoAnalysis /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/payments" element={<ProtectedRoute><Layout><YegoMiAutoPayments /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/rent-sale" element={<ProtectedRoute><Layout><YegoMiAutoLoans /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/rent-sale/:id" element={<ProtectedRoute><Layout><YegoMiAutoRentSaleDetail /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-auto/loans" element={<Navigate to="/admin/yego-mi-auto/rent-sale" replace />} />
            <Route path="/admin/yego-mi-auto/loan-requests/new" element={<ProtectedRoute><Layout><YegoMiAutoNewRequest /></Layout></ProtectedRoute>} />
            {/* Yego mi moto */}
            <Route path="/admin/yego-mi-moto" element={<Navigate to="/admin/yego-mi-moto/dashboard" replace />} />
            <Route path="/admin/yego-mi-moto/dashboard" element={<ProtectedRoute><Layout><YegoMiMotoDashboard /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/flotas" element={<ProtectedRoute><Layout><YegoMiMotoFlotas /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/config" element={<ProtectedRoute><Layout><YegoMiMotoConfig /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/analysis" element={<ProtectedRoute><Layout><YegoMiMotoAnalysis /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/payments" element={<ProtectedRoute><Layout><YegoMiMotoPayments /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/loans" element={<ProtectedRoute><Layout><YegoMiMotoLoans /></Layout></ProtectedRoute>} />
            <Route path="/admin/yego-mi-moto/loan-requests/new" element={<ProtectedRoute><Layout><YegoMiMotoNewRequest /></Layout></ProtectedRoute>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;

