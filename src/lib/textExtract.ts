import { pdfjs } from "react-pdf";
import "@/lib/pdfWorker";
import ePub from "epubjs";

export interface PageText {
  page: number;
  text: string;
  words: string[];
}

export async function extractPdfPages(file: File | Blob): Promise<PageText[]> {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const pages: PageText[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const text = (tc.items as any[]).map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    pages.push({ page: i, text, words: text.split(/\s+/).filter(Boolean) });
    
    // Yield to main thread every 5 pages to prevent browser UI from freezing
    if (i % 5 === 0) await new Promise(r => setTimeout(r, 10));
  }
  return pages;
}

export async function extractEpubPages(file: File | Blob): Promise<PageText[]> {
  const buf = await file.arrayBuffer();
  const book = ePub(buf);
  await book.ready;
  const spine: any = (book as any).spine;
  const items: any[] = spine.spineItems || [];
  const pages: PageText[] = [];
  let idx = 1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const doc: any = await item.load(book.load.bind(book));
      const text = (doc?.body?.textContent || "").replace(/\s+/g, " ").trim();
      if (text) {
        pages.push({ page: idx, text, words: text.split(/\s+/).filter(Boolean) });
        idx++;
      }
      item.unload?.();
    } catch (e) {
      console.error("epub section error", e);
    }
    
    // Yield to main thread every few sections
    if (i % 2 === 0) await new Promise(r => setTimeout(r, 10));
  }
  return pages;
}
