import { ProcessingDocument } from '../types';
import { ProcessingPhase } from '../types';

interface Props {
  doc: ProcessingDocument;
  phase: ProcessingPhase;
  scanProgress: number;
}

const FakeDocumentContent = ({ color }: { color: string }) => (
  <div className="flex flex-col h-full p-6 gap-3">
    <div className="flex items-start justify-between mb-2">
      <div className="flex flex-col gap-1.5">
        <div className="h-2.5 rounded-full bg-gray-800 w-48" />
        <div className="h-1.5 rounded-full bg-gray-400 w-32" />
      </div>
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <div className="w-5 h-5 rounded" style={{ backgroundColor: color, opacity: 0.7 }} />
      </div>
    </div>

    <div className="h-px bg-gray-200" />

    <div className="grid grid-cols-3 gap-2 text-xs">
      {['Rev', 'Date', 'Status'].map((label) => (
        <div key={label} className="flex flex-col gap-1">
          <div className="h-1 rounded-full bg-gray-300 w-8" />
          <div className="h-2 rounded-full" style={{ backgroundColor: `${color}40`, width: '60%' }} />
        </div>
      ))}
    </div>

    <div className="h-px bg-gray-200" />

    <div className="flex flex-col gap-2 flex-1">
      {[72, 90, 55, 80, 65, 88, 50, 75, 60, 85].map((w, i) => (
        <div key={i} className="flex gap-2 items-center">
          {i % 3 === 0 && (
            <div className="w-1 h-1 rounded-full bg-gray-400 flex-shrink-0 mt-0.5" />
          )}
          <div
            className="h-1.5 rounded-full bg-gray-200"
            style={{ width: `${w}%`, ...(i === 0 ? { backgroundColor: `${color}30` } : {}) }}
          />
        </div>
      ))}
    </div>

    <div className="h-px bg-gray-200 mt-auto" />

    <div className="grid grid-cols-4 gap-2">
      {[40, 55, 45, 50].map((w, i) => (
        <div key={i} className="h-1 rounded-full bg-gray-200" style={{ width: `${w}%` }} />
      ))}
    </div>

    <div
      className="absolute bottom-4 right-6 rounded-md px-3 py-1.5 text-xs font-semibold"
      style={{ backgroundColor: color, color: 'white', opacity: 0.9 }}
    >
      Page 1
    </div>
  </div>
);

export default function ScannerView({ doc, phase, scanProgress }: Props) {
  const isScanning = phase === 'scanning';

  return (
    <div className="relative flex flex-col" style={{ width: 320 }}>
      <div className="text-[10px] uppercase tracking-widest text-gray-400 font-medium mb-2 text-center">
        Scanner Station
      </div>

      <div
        className="relative rounded-xl overflow-hidden bg-white transition-all duration-500"
        style={{
          height: 420,
          boxShadow: isScanning
            ? `0 0 0 2px ${doc.accentColor}60, 0 8px 40px -8px ${doc.accentColor}50, 0 4px 16px -4px rgba(0,0,0,0.15)`
            : '0 4px 24px -4px rgba(0,0,0,0.12), 0 2px 8px -2px rgba(0,0,0,0.06)',
        }}
      >
        <div
          className="h-1.5 w-full"
          style={{ backgroundColor: doc.accentColor }}
        />

        <FakeDocumentContent color={doc.accentColor} />

        {isScanning && (
          <>
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${scanProgress}%`,
                height: 3,
                background: `linear-gradient(to right, transparent 0%, ${doc.accentColor}80 20%, ${doc.accentColor} 50%, ${doc.accentColor}80 80%, transparent 100%)`,
                boxShadow: `0 0 12px 4px ${doc.accentColor}60, 0 0 24px 8px ${doc.accentColor}30`,
                transition: 'top 80ms linear',
              }}
            />
            <div
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${Math.max(0, scanProgress - 8)}%`,
                height: '8%',
                background: `linear-gradient(to bottom, transparent 0%, ${doc.accentColor}10 50%, transparent 100%)`,
                transition: 'top 80ms linear',
              }}
            />
          </>
        )}

        {(phase === 'revealing' || phase === 'holding') && (
          <div
            className="absolute inset-0 pointer-events-none transition-opacity duration-500"
            style={{
              background: `linear-gradient(135deg, ${doc.accentColor}06 0%, transparent 60%)`,
              opacity: 1,
            }}
          />
        )}
      </div>

      <div className="flex items-center justify-center gap-2 mt-3">
        <div
          className={[
            'w-1.5 h-1.5 rounded-full transition-all duration-300',
            isScanning ? 'animate-pulse' : '',
          ].join(' ')}
          style={{
            backgroundColor: isScanning
              ? doc.accentColor
              : phase === 'revealing' || phase === 'holding'
              ? '#10b981'
              : '#d1d5db',
          }}
        />
        <span className="text-xs text-gray-400 font-medium">
          {isScanning
            ? 'Extracting metadata...'
            : phase === 'revealing' || phase === 'holding'
            ? 'Extraction complete'
            : 'Ready'}
        </span>
      </div>

      <div className="text-center mt-1">
        <span className="text-[10px] text-gray-400 truncate block px-4">{doc.filename}</span>
      </div>
    </div>
  );
}
