import { pdfjs } from 'react-pdf';

// Vite turns this URL into an emitted worker asset. react-pdf's README says to set it in the
// module tree that renders <Document>, so EvidencePanel imports this file (not main.tsx):
// otherwise react-pdf's own default could overwrite it depending on module order.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();
