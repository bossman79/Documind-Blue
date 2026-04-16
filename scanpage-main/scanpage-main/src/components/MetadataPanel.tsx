import { ProcessingDocument } from '../types';

interface Props {
  doc: ProcessingDocument;
  visibleFields: number;
}

const STATUS_LABELS: Record<string, string> = {
  AB: 'As-Built', APR: 'Approved', BID: 'For Bid', CRT: 'Certified',
  FYU: 'For Your Use', IFA: 'Issued for Approval', IFC: 'Issued for Construction',
  IFR: 'Issued for Review', PRE: 'Preliminary', REC: 'For Records',
  RFE: 'Released for Engineering', RWC: 'Returned w/ Comments',
};

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  APR: { bg: '#dcfce7', text: '#15803d' },
  IFC: { bg: '#dbeafe', text: '#1d4ed8' },
  IFA: { bg: '#fef9c3', text: '#a16207' },
  IFR: { bg: '#fef3c7', text: '#b45309' },
  PRE: { bg: '#f3f4f6', text: '#6b7280' },
  FYU: { bg: '#ede9fe', text: '#6d28d9' },
  RWC: { bg: '#fee2e2', text: '#b91c1c' },
  AB: { bg: '#d1fae5', text: '#065f46' },
  BID: { bg: '#fce7f3', text: '#9d174d' },
  CRT: { bg: '#cffafe', text: '#0e7490' },
  REC: { bg: '#e0f2fe', text: '#0369a1' },
  RFE: { bg: '#f0fdf4', text: '#166534' },
};

interface FieldProps {
  label: string;
  value: string | null | undefined;
  visible: boolean;
  accent?: boolean;
  color?: string;
  wide?: boolean;
  badge?: boolean;
}

function Field({ label, value, visible, accent, color, wide, badge }: FieldProps) {
  if (!value) return null;
  const statusStyle = badge ? STATUS_COLORS[value] : undefined;

  return (
    <div
      className={[
        'flex flex-col gap-0.5 transition-all duration-400',
        wide ? 'col-span-2' : 'col-span-1',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2',
      ].join(' ')}
      style={{ transitionProperty: 'opacity, transform' }}
    >
      <span className="text-[10px] uppercase tracking-wider text-gray-400 font-medium">{label}</span>
      {badge ? (
        <span
          className="text-xs font-semibold rounded-md px-2 py-0.5 w-fit"
          style={{ backgroundColor: statusStyle?.bg, color: statusStyle?.text }}
        >
          {STATUS_LABELS[value] ?? value}
        </span>
      ) : (
        <span
          className="text-xs font-medium leading-snug"
          style={{ color: accent && color ? color : '#111827' }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

export default function MetadataPanel({ doc, visibleFields }: Props) {
  const m = doc.metadata;

  const fields: Array<FieldProps & { key: string }> = [
    { key: 'description_title', label: 'Title', value: m.description_title, visible: false, accent: true, color: doc.accentColor, wide: true },
    { key: 'document_type', label: 'Document Type', value: m.document_type, visible: false, wide: false },
    { key: 'issue_status', label: 'Status', value: m.issue_status, visible: false, badge: true },
    { key: 'revision', label: 'Revision', value: m.revision, visible: false },
    { key: 'revision_date', label: 'Rev Date', value: m.revision_date, visible: false },
    { key: 'discipline', label: 'Discipline', value: m.discipline, visible: false },
    { key: 'category', label: 'Category', value: m.category, visible: false },
    { key: 'plant', label: 'Plant', value: m.plant, visible: false, wide: true },
    { key: 'department_code', label: 'Dept Code', value: m.department_code, visible: false },
    { key: 'vendor_name', label: 'Vendor', value: m.vendor_name, visible: false, wide: true },
    { key: 'asset_id_number', label: 'Asset ID', value: m.asset_id_number, visible: false },
    { key: 'project', label: 'Project', value: m.project, visible: false, wide: true },
  ].filter(f => f.value !== null && f.value !== undefined);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-gray-100" />
        <span className="text-[10px] uppercase tracking-widest text-gray-400 font-medium">
          Extracted Metadata
        </span>
        <div className="h-px flex-1 bg-gray-100" />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {fields.map(({ key: fieldKey, ...field }, i) => (
          <Field
            key={fieldKey}
            {...field}
            visible={i < visibleFields}
          />
        ))}
      </div>

      {visibleFields >= fields.length && visibleFields > 0 && (
        <div
          className="flex items-center gap-2 mt-1 pt-3 border-t border-gray-100 transition-opacity duration-500"
          style={{ opacity: visibleFields >= fields.length ? 1 : 0 }}
        >
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          <span className="text-xs text-emerald-600 font-medium">
            {fields.filter(f => f.value).length} fields extracted successfully
          </span>
        </div>
      )}
    </div>
  );
}
