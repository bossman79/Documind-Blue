export interface DocumentMetadata {
  description_title: string;
  document_type: string;
  revision: string;
  revision_date: string;
  issue_status: string;
  discipline: string | null;
  category: string | null;
  plant: string | null;
  department_code: string | null;
  vendor_name: string | null;
  asset_id_number: string | null;
  project: string | null;
}

export interface ProcessingDocument {
  id: number;
  filename: string;
  pageCount: number;
  fileSize: string;
  accentColor: string;
  documentKind: 'drawing' | 'report' | 'manual' | 'spec' | 'invoice';
  metadata: DocumentMetadata;
}

export type ProcessingPhase = 'idle' | 'scanning' | 'revealing' | 'holding' | 'advancing';
