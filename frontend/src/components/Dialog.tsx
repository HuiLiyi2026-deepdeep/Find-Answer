import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  variant?: 'side' | 'confirm';
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, description, children, variant = 'side' }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreRef = useRef<(() => void) | null>(null);
  const reduceMotion = useReducedMotion();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || restoreRef.current) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panelRef.current)?.focus();
    }, 30);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!focusable.length) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    restoreRef.current = () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
      restoreRef.current = null;
    };
  }, [open]);

  useEffect(() => () => {
    restoreRef.current?.();
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence onExitComplete={() => restoreRef.current?.()}>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.18 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            className={`dialog-panel dialog-${variant}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            initial={{ opacity: 0, x: reduceMotion ? 0 : variant === 'side' ? 20 : 0, y: reduceMotion ? 0 : variant === 'confirm' ? 8 : 0 }}
            animate={{ opacity: 1, x: 0, y: 0 }}
            exit={{ opacity: 0, x: reduceMotion ? 0 : variant === 'side' ? 14 : 0, y: reduceMotion ? 0 : variant === 'confirm' ? 5 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="dialog-header">
              <div>
                <p className="eyebrow">{variant === 'side' ? '资料原文' : '请确认'}</p>
                <h2 id={titleId}>{title}</h2>
                {description && <p id={descriptionId}>{description}</p>}
              </div>
              <button type="button" className="icon-button" onClick={onClose} aria-label="关闭对话框">
                <X size={19} aria-hidden="true" />
              </button>
            </div>
            <div className="dialog-content">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
