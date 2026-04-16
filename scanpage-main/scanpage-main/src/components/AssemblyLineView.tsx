import { useState, useEffect, useRef } from 'react';
import { Layers, ChevronRight } from 'lucide-react';
import { DEMO_DOCUMENTS } from '../data/documents';
import { ProcessingPhase } from '../types';
import DocumentThumbnail from './DocumentThumbnail';
import ScannerView from './ScannerView';
import MetadataPanel from './MetadataPanel';

const TOTAL_DOCS = 24;
const SCAN_DURATION_MS = 3200;
const REVEAL_INTERVAL_MS = 160;
const HOLD_DURATION_MS = 2200;
const ADVANCE_DURATION_MS = 700;

export default function AssemblyLineView() {
  const [activeIdx, setActiveIdx] = useState(0);
  const [phase, setPhase] = useState<ProcessingPhase>('scanning');
  const [scanProgress, setScanProgress] = useState(0);
  const [visibleFields, setVisibleFields] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [isAdvancing, setIsAdvancing] = useState(false);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const activeDoc = DEMO_DOCUMENTS[activeIdx % DEMO_DOCUMENTS.length];
  const overallProgress = Math.round(((completedCount % TOTAL_DOCS) / TOTAL_DOCS) * 100);

  const getQueueDocs = () =>
    [3, 2, 1].map((offset) => {
      const idx =
        ((activeIdx - offset) % DEMO_DOCUMENTS.length + DEMO_DOCUMENTS.length) %
        DEMO_DOCUMENTS.length;
      return { doc: DEMO_DOCUMENTS[idx], offset };
    });

  useEffect(() => {
    if (phase !== 'scanning') return;
    setScanProgress(0);
    const steps = 60;
    const intervalMs = SCAN_DURATION_MS / steps;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      setScanProgress(Math.min((step / steps) * 100, 100));
      if (step >= steps) {
        clearInterval(timer);
        setPhase('revealing');
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [phase, activeIdx]);

  useEffect(() => {
    if (phase !== 'revealing') return;
    let fieldIdx = 0;
    const totalFields = 12;
    const timer = setInterval(() => {
      fieldIdx++;
      setVisibleFields(fieldIdx);
      if (fieldIdx >= totalFields) {
        clearInterval(timer);
        setTimeout(() => {
          if (phaseRef.current === 'revealing') setPhase('holding');
        }, 400);
      }
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'holding') return;
    const timer = setTimeout(() => setPhase('advancing'), HOLD_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'advancing') return;
    setIsAdvancing(true);
    setCompletedCount((c) => c + 1);
    const timer = setTimeout(() => {
      setActiveIdx((i) => (i + 1) % DEMO_DOCUMENTS.length);
      setVisibleFields(0);
      setScanProgress(0);
      setIsAdvancing(false);
      setPhase('scanning');
    }, ADVANCE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const queueDocs = getQueueDocs();

  return (
    <div className="min-h-screen bg-[#f4f6f9] flex flex-col">
      <header className="bg-white border-b border-gray-200 px-8 py-4 flex-shrink-0">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
                <Layers className="w-4 h-4 text-white" />
              </div>
              <div>
                <h1 className="text-[15px] font-semibold text-gray-900">Assembly Line View</h1>
                <p className="text-[11px] text-gray-400">
                  {completedCount % TOTAL_DOCS} of {TOTAL_DOCS} documents processed
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[11px] font-medium text-blue-600">
                {overallProgress}%
              </span>
              <div className="w-48 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-500"
                  style={{ width: `${overallProgress}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-8 py-6 flex flex-col gap-5">
        <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-5">
            <span className="text-[10px] uppercase tracking-widest text-gray-400 font-semibold">
              Document Queue
            </span>
            <div className="h-px flex-1 bg-gray-100" />
            <span className="text-[10px] text-gray-400">
              {DEMO_DOCUMENTS.length - (activeIdx % DEMO_DOCUMENTS.length)} remaining
            </span>
          </div>

          <div className="flex items-end gap-0">
            <div className="flex items-end gap-3 relative">
              <div
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full"
                style={{
                  background: 'repeating-linear-gradient(to right, #e5e7eb 0px, #e5e7eb 8px, transparent 8px, transparent 16px)',
                  bottom: -8,
                }}
              />
              {queueDocs.map(({ doc, offset }, i) => (
                <div
                  key={`${activeIdx}-${offset}`}
                  className="transition-all duration-500"
                  style={{
                    opacity: isAdvancing ? (i === 2 ? 0.6 : 0.8) : [0.35, 0.55, 0.75][i],
                    transform: isAdvancing ? 'translateX(24px)' : 'translateX(0)',
                  }}
                >
                  <DocumentThumbnail doc={doc} position="queue" index={3 - i} />
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1 mx-3 mb-4">
              {[0, 1, 2].map((i) => (
                <ChevronRight
                  key={i}
                  className="w-4 h-4 text-blue-400"
                  style={{ opacity: 0.4 + i * 0.2 }}
                />
              ))}
            </div>

            <div
              className="relative flex flex-col items-center"
              style={{
                transform: isAdvancing ? 'scale(0.92)' : 'scale(1)',
                transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <div
                className="absolute -top-5 left-0 right-0 flex items-center justify-center gap-1.5"
              >
                <div className="h-px w-8 bg-gray-200" />
                <span className="text-[9px] uppercase tracking-widest text-gray-400 font-medium">
                  Active
                </span>
                <div className="h-px w-8 bg-gray-200" />
              </div>
              <DocumentThumbnail doc={activeDoc} position="active" index={0} />
            </div>

            <div className="ml-6 flex items-center self-end mb-2">
              <div
                className="w-8 h-0.5 rounded-full"
                style={{
                  background: `linear-gradient(to right, #e5e7eb, ${activeDoc.accentColor}60)`,
                }}
              />
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: `${activeDoc.accentColor}60` }}
              />
            </div>

            <div
              className="ml-1 flex items-center justify-center rounded-full px-3 py-1.5 self-end mb-0.5"
              style={{
                backgroundColor: `${activeDoc.accentColor}12`,
                border: `1px solid ${activeDoc.accentColor}30`,
              }}
            >
              <span
                className="text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: activeDoc.accentColor }}
              >
                Scanner
              </span>
            </div>
          </div>
        </div>

        <div className="flex gap-5 flex-1">
          <div className="flex-shrink-0">
            <ScannerView doc={activeDoc} phase={phase} scanProgress={scanProgress} />
          </div>

          <div
            className="flex-1 bg-white rounded-2xl border border-gray-200 p-6 shadow-sm transition-all duration-500"
            style={{
              opacity: phase === 'scanning' ? 0.4 : 1,
            }}
          >
            <MetadataPanel
              doc={activeDoc}
              visibleFields={phase === 'scanning' ? 0 : visibleFields}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
