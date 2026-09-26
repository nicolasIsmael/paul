import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { Button, ErrorState, PageLoader } from "./components/ui";
import { useAuth } from "./context/AuthContext";
import { isPreviewMode, isSupabaseConfigured } from "./lib/supabase";
import { AuthPage } from "./pages/AuthPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { NotFoundPage } from "./pages/NotFoundPage";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const PoolsPage = lazy(() => import("./pages/PoolsPage").then((module) => ({ default: module.PoolsPage })));
const PoolDetailPage = lazy(() => import("./pages/PoolDetailPage").then((module) => ({ default: module.PoolDetailPage })));
const PositionsPage = lazy(() => import("./pages/PositionsPage").then((module) => ({ default: module.PositionsPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((module) => ({ default: module.ProfilePage })));
const LiquidationsPage = lazy(() => import("./pages/LiquidationsPage").then((module) => ({ default: module.LiquidationsPage })));

function ProtectedLayout() {
  const { session, profile, loading, profileLoading, profileError, refreshProfile, signOut } = useAuth();
  if (loading || (session && profileLoading && !profile)) return <PageLoader />;
  if (!session) return <Navigate to="/acceso" replace />;
  if (!profile && profileError) {
    return (
      <main className="route-error-page">
        <ErrorState message={profileError} retry={() => void refreshProfile()} />
        <Button variant="ghost" onClick={() => void signOut()}>Cerrar sesión</Button>
      </main>
    );
  }
  if (!profile) return <PageLoader label="Sincronizando tu perfil" />;
  return <AppShell />;
}

function InvestorOnly({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  return profile?.rol === "inversionista" ? children : <Navigate to="/" replace />;
}

function OperatorOnly({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  return profile?.rol === "operador_banco" ? children : <Navigate to="/" replace />;
}

export default function App() {
  if (!isSupabaseConfigured && !isPreviewMode) return <ConfigurationPage />;
  return <Suspense fallback={<PageLoader label="Cargando pantalla" />}><Routes><Route path="/acceso" element={<AuthPage />} /><Route element={<ProtectedLayout />}><Route index element={<DashboardPage />} /><Route path="pools" element={<PoolsPage />} /><Route path="pools/:poolId" element={<PoolDetailPage />} /><Route path="posiciones" element={<InvestorOnly><PositionsPage /></InvestorOnly>} /><Route path="liquidaciones" element={<OperatorOnly><LiquidationsPage /></OperatorOnly>} /><Route path="perfil" element={<ProfilePage />} /></Route><Route path="*" element={<NotFoundPage />} /></Routes></Suspense>;
}
