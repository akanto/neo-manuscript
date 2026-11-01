declare module "*.css" {
  const text: string;
  export default text;
}

/** WordNet as the view's synonyms take it, gzipped and in base64; made by scripts/thesaurus.ts when the view is built. */
declare module "thesaurus:packed" {
  const packed: string;
  export default packed;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  const code: string;
  export default code;
}
