import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Home from './pages/Home';
import LandingPage from './pages/LandingPage';
import LoanRequestPE from './pages/LoanRequestPE';
import LoanRequestCO from './pages/LoanRequestCO';
import GuarantorSignaturePublic from './pages/GuarantorSignaturePublic';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import LoanRequests from './pages/LoanRequests';
import LoanRequestDetail from './pages/LoanRequestDetail';
import Loans from './pages/Loans';
import LoanDetail from './pages/LoanDetail';
import Payments from './pages/Payments';
import Analysis from './pages/Analysis';
import Settings from './pages/Settings';
import Provisions from './pages/Provisions';
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
import SelectFlota from './pages/driver/SelectFlota';
import AdminNewLoanRequest from './pages/admin/AdminNewLoanRequest';
import { AuthProvider } from './contexts/AuthContext';

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
              <Route path="profile" element={<DriverProfile />} />
            </Route>
            
            {/* Admin routes */}
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
                    <AdminNewLoanRequest />
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
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;

