import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { PageLoader } from "./components/ui";
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

function ProtectedLayout() {
  const { session, profile, loading, profileLoading } = useAuth();
  if (loading || (session && profileLoading && !profile)) return <PageLoader />;
  if (!session) return <Navigate to="/acceso" replace />;
  if (!profile) return <PageLoader label="Sincronizando tu perfil" />;
  return <AppShell />;
}

function InvestorOnly({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  return profile?.rol === "inversionista" ? children : <Navigate to="/" replace />;
}

export default function App() {
  if (!isSupabaseConfigured && !isPreviewMode) return <ConfigurationPage />;
  return <Suspense fallback={<PageLoader label="Cargando pantalla" />}><Routes><Route path="/acceso" element={<AuthPage />} /><Route element={<ProtectedLayout />}><Route index element={<DashboardPage />} /><Route path="pools" element={<PoolsPage />} /><Route path="pools/:poolId" element={<PoolDetailPage />} /><Route path="posiciones" element={<InvestorOnly><PositionsPage /></InvestorOnly>} /><Route path="perfil" element={<ProfilePage />} /></Route><Route path="*" element={<NotFoundPage />} /></Routes></Suspense>;
}
