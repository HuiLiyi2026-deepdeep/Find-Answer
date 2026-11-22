import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Cable, FileSearch, Files, MessageSquareText } from 'lucide-react';
import { NavLink, useLocation, useOutlet } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';

const navigation = [
  { to: '/ask', label: '提问', icon: MessageSquareText },
  { to: '/documents', label: '资料库', icon: Files },
  { to: '/connections', label: '模型连接', icon: Cable },
];

export function AppShell() {
  const location = useLocation();
  const outlet = useOutlet();
  const reduceMotion = useReducedMotion();
  const { health, healthLoading, healthError, documents } = useWorkspace();

  const publicMode = health?.mode === 'public';
  const connected = Boolean(health);
  const statusLabel = connected
    ? publicMode ? '临时资料库已连接' : '本地服务已连接'
    : healthLoading ? '正在连接资料库' : '资料库未连接';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <NavLink to="/ask" className="brand" aria-label="FindAnswer 首页">
          <span className="brand-mark"><FileSearch size={20} strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="brand-copy">
            <strong>FindAnswer</strong>
            <small>资料工作台</small>
          </span>
        </NavLink>

        <nav className="main-nav" aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="local-status" title={healthError ?? statusLabel}>
            <span className={`status-dot${connected ? ' online' : healthLoading ? ' checking' : ' offline'}`} aria-hidden="true" />
            <span>{statusLabel}</span>
          </div>
          <span className="document-tally">{health?.document_count ?? documents.length} 份{publicMode ? '临时资料' : '本地资料'}</span>
        </div>
      </aside>

      <div className="app-main">
        <AnimatePresence
          mode="wait"
          initial={false}
          onExitComplete={() => window.scrollTo({ top: 0, behavior: 'auto' })}
        >
          <motion.div
            className="route-frame"
            key={location.pathname}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 7 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {outlet}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
