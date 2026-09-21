import {
  BriefcaseBusiness,
  ChevronDown,
  CircleUserRound,
  LayoutDashboard,
  LogOut,
  Menu,
  PieChart,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { initials, roleLabel } from "../lib/format";
import { isPreviewMode } from "../lib/supabase";
import { Brand } from "./Brand";

const investorNavigation = [
  { to: "/", label: "Resumen", icon: LayoutDashboard, end: true },
  { to: "/pools", label: "Oportunidades", icon: PieChart },
  { to: "/posiciones", label: "Mis posiciones", icon: BriefcaseBusiness },
  { to: "/perfil", label: "Perfil y wallet", icon: WalletCards },
];

const operatorNavigation = [
  { to: "/", label: "Resumen", icon: LayoutDashboard, end: true },
  { to: "/pools", label: "Pools", icon: PieChart },
  { to: "/perfil", label: "Mi perfil", icon: CircleUserRound },
];

export function AppShell() {
  const { profile, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigation = profile?.rol === "operador_banco" ? operatorNavigation : investorNavigation;

  useEffect(() => {
    setMobileOpen(false);
    setUserMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!userMenuOpen) return;
    function closeMenu(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && userMenuRef.current?.contains(event.target as Node)) return;
      setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenu);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenu);
    };
  }, [userMenuOpen]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand"><Brand inverse /></div>
        <button className="sidebar__close icon-button icon-button--inverse" onClick={() => setMobileOpen(false)} aria-label="Cerrar menú"><X size={20} /></button>
        <nav className="sidebar__nav" aria-label="Navegación principal">
          <span className="sidebar__label">PLATAFORMA</span>
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)} className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}>
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__network">
          <span className="network-dot" />
          <div><strong>Stellar Testnet</strong><small>Red de demostración</small></div>
        </div>
      </aside>

      {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="Cerrar navegación" />}

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button topbar__menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menú"><Menu size={21} /></button>
          <div className="topbar__spacer" />
          <div className="topbar__status"><span className="network-dot" /> {isPreviewMode ? "Vista previa local" : "Testnet conectada"}</div>
          <div className="user-menu" ref={userMenuRef}>
            <button className="user-menu__trigger" onClick={() => setUserMenuOpen((open) => !open)} aria-expanded={userMenuOpen} aria-haspopup="menu" aria-controls="user-menu-popover">
              <span className="avatar">{initials(profile?.nombre_completo || "Paul")}</span>
              <span className="user-menu__copy"><strong>{profile?.nombre_completo || "Usuario"}</strong><small>{profile ? roleLabel(profile.rol) : "Cargando"}</small></span>
              <ChevronDown size={16} />
            </button>
            {userMenuOpen && (
              <div className="user-menu__popover" id="user-menu-popover" role="menu">
                <NavLink to="/perfil" onClick={() => setUserMenuOpen(false)}><CircleUserRound size={17} /> Ver perfil</NavLink>
                <button onClick={() => void signOut()}><LogOut size={17} /> Cerrar sesión</button>
              </div>
            )}
          </div>
        </header>
        <div className="page-container"><Outlet /></div>
      </main>
    </div>
  );
}
