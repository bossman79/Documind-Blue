import { ProcessingDocument } from '../types';
import { FileText, FileBarChart2, BookOpen, FileCheck, Receipt } from 'lucide-react';

interface Props {
  doc: ProcessingDocument;
  position: 'queue' | 'active' | 'done';
  index: number;
}

const kindIcon = (kind: ProcessingDocument['documentKind'], color: string) => {
  const cls = `w-4 h-4`;
  switch (kind) {
    case 'drawing': return <FileText className={cls} style={{ color }} />;
    case 'manual': return <BookOpen className={cls} style={{ color }} />;
    case 'report': return <FileBarChart2 className={cls} style={{ color }} />;
    case 'spec': return <FileCheck className={cls} style={{ color }} />;
    case 'invoice': return <Receipt className={cls} style={{ color }} />;
  }
};

const FakePage = ({ color, rows = 7 }: { color: string; rows?: number }) => (
  <div className="flex flex-col gap-1 p-2 w-full">
    <div className="flex items-center gap-1 mb-1">
      <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: color, opacity: 0.8 }} />
      <div className="h-1.5 rounded-full bg-gray-300 flex-1" />
    </div>
    <div className="h-px bg-gray-200 mb-1" />
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex gap-1">
        <div
          className="h-1 rounded-full"
          style={{
            backgroundColor: i === 0 ? color : '#d1d5db',
            opacity: i === 0 ? 0.6 : 1,
            width: i === 0 ? '60%' : `${45 + (i * 17) % 40}%`,
          }}
        />
      </div>
    ))}
    <div className="mt-auto pt-1 flex gap-1">
      <div className="h-1 rounded-full bg-gray-200 w-8" />
      <div className="h-1 rounded-full bg-gray-200 w-6" />
    </div>
  </div>
);

export default function DocumentThumbnail({ doc, position, index }: Props) {
  const isActive = position === 'active';
  const isDone = position === 'done';

  return (
    <div
      className={[
        'relative flex flex-col rounded-lg overflow-hidden select-none transition-all duration-500',
        isActive
          ? 'w-24 h-32 shadow-xl ring-2'
          : 'w-16 h-22 shadow-sm',
        isDone ? 'opacity-30 scale-95' : 'opacity-100 scale-100',
      ].join(' ')}
      style={{
        background: 'white',
        ...(isActive ? {
          boxShadow: `0 0 0 2px ${doc.accentColor}60, 0 4px 24px -4px ${doc.accentColor}40, 0 2px 8px -2px rgba(0,0,0,0.12)`,
        } : {}),
      }}
    >
      <div
        className="h-1.5 w-full flex-shrink-0"
        style={{ backgroundColor: doc.accentColor }}
      />
      <div className="flex-1 flex flex-col p-1.5">
        <FakePage color={doc.accentColor} rows={isActive ? 7 : 5} />
      </div>
      <div
        className="absolute bottom-0 left-0 right-0 px-1.5 py-1 flex items-center gap-1"
        style={{ background: `${doc.accentColor}12` }}
      >
        {kindIcon(doc.documentKind, doc.accentColor)}
        {isActive && (
          <span className="text-[8px] font-medium truncate" style={{ color: doc.accentColor }}>
            pg {doc.pageCount}
          </span>
        )}
      </div>
      {index > 0 && position === 'queue' && (
        <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center">
          <span className="text-[7px] text-white font-bold">{index}</span>
        </div>
      )}
    </div>
  );
}
