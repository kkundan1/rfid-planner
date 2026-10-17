'use client';
import { useEffect } from 'react';
import { SHELL_HTML } from '@/lib/shell';
import { installShim } from '@/lib/claude-shim';

export default function PlannerClient({ me }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      installShim(me);
      const { jsPDF } = await import('jspdf');
      window.jspdf = { jsPDF };
      window.__loadXlsx = () => import('xlsx').then((m) => { window.XLSX = m.utils ? m : m.default; });
      const { startPlanner } = await import('@/lib/planner-engine');
      if (!cancelled) startPlanner();
    })();
    return () => { cancelled = true; };
  }, [me]);

  return <div id="planner-root" dangerouslySetInnerHTML={{ __html: SHELL_HTML }} suppressHydrationWarning />;
}
