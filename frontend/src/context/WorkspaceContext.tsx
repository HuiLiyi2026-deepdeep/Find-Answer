import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { endSession, getDocuments, getHealth, registerUnloadCleanup } from '../lib/api';
import type { DocumentRecord, Health } from '../lib/types';

interface WorkspaceValue {
  health: Health | null;
  documents: DocumentRecord[];
  healthLoading: boolean;
  documentsLoading: boolean;
  healthError: string | null;
  documentsError: string | null;
  refreshHealth: () => Promise<void>;
  refreshDocuments: () => Promise<void>;
  refreshAll: () => Promise<void>;
  resetExperience: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [healthLoading, setHealthLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const healthRequestIdRef = useRef(0);
  const documentsRequestIdRef = useRef(0);
  const healthControllerRef = useRef<AbortController | null>(null);
  const documentsControllerRef = useRef<AbortController | null>(null);

  const refreshHealth = useCallback(async () => {
    const requestId = ++healthRequestIdRef.current;
    healthControllerRef.current?.abort();
    const controller = new AbortController();
    healthControllerRef.current = controller;
    setHealthLoading(true);
    setHealthError(null);
    try {
      const response = await getHealth(controller.signal);
      if (requestId !== healthRequestIdRef.current) return;
      setHealth(response);
    } catch (error) {
      if (requestId !== healthRequestIdRef.current) return;
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : '无法获取服务状态。');
    } finally {
      if (requestId === healthRequestIdRef.current) {
        healthControllerRef.current = null;
        setHealthLoading(false);
      }
    }
  }, []);

  const refreshDocuments = useCallback(async () => {
    const requestId = ++documentsRequestIdRef.current;
    documentsControllerRef.current?.abort();
    const controller = new AbortController();
    documentsControllerRef.current = controller;
    setDocumentsLoading(true);
    setDocumentsError(null);
    try {
      const response = await getDocuments(controller.signal);
      if (requestId !== documentsRequestIdRef.current) return;
      setDocuments(response.documents);
    } catch (error) {
      if (requestId !== documentsRequestIdRef.current) return;
      setDocumentsError(error instanceof Error ? error.message : '无法获取资料列表。');
    } finally {
      if (requestId === documentsRequestIdRef.current) {
        documentsControllerRef.current = null;
        setDocumentsLoading(false);
      }
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshHealth(), refreshDocuments()]);
  }, [refreshDocuments, refreshHealth]);

  const resetExperience = useCallback(async () => {
    await endSession();
    // Clear immediately so a failed refresh cannot show the deleted rows.
    setDocuments([]);
    await refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    void refreshAll();
    return () => {
      healthRequestIdRef.current += 1;
      documentsRequestIdRef.current += 1;
      healthControllerRef.current?.abort();
      documentsControllerRef.current?.abort();
    };
  }, [refreshAll]);

  useEffect(() => registerUnloadCleanup(), []);

  const value = useMemo<WorkspaceValue>(() => ({
    health,
    documents,
    healthLoading,
    documentsLoading,
    healthError,
    documentsError,
    refreshHealth,
    refreshDocuments,
    refreshAll,
    resetExperience,
  }), [
    health,
    documents,
    healthLoading,
    documentsLoading,
    healthError,
    documentsError,
    refreshHealth,
    refreshDocuments,
    refreshAll,
    resetExperience,
  ]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace 必须在 WorkspaceProvider 内使用。');
  return value;
}
