import { useEffect, useRef, useState, useCallback } from "react";
import { Document, Page } from "react-pdf";
import { pdfjs } from "react-pdf";
import "@/lib/pdfWorker";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { cn } from "@/lib/utils";

interface WordPosition {
  word: string;
  x: number;
  y: number;
  width: number;
  height: number;
  globalIndex: number;
}

interface PdfPageRendererProps {
  fileUrl: string;
  pageNumber: number;
  pageStartGlobal: number;
  highlightedWordOnPage: number | null;
  resumeWordOnPage: number | null;
  currentWordGlobal: number;
  onWordClick: (globalIndex: number) => void;
  onDocumentLoad: (numPages: number) => void;
  width?: number;
}

/**
 * Renders a single PDF page with word-level highlight overlays.
 * Uses the actual rendered text layer positions for precise alignment.
 */
export default function PdfPageRenderer({
  fileUrl,
  pageNumber,
  pageStartGlobal,
  highlightedWordOnPage,
  resumeWordOnPage,
  currentWordGlobal,
  onWordClick,
  onDocumentLoad,
  width,
}: PdfPageRendererProps) {
  const [wordPositions, setWordPositions] = useState<WordPosition[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLDivElement>(null);
  const resumeWordRef = useRef<HTMLDivElement>(null);
  const [renderWidth, setRenderWidth] = useState<number | undefined>(width);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);

  // When the page loads, set render width and extract text positions
  const handlePageLoadSuccess = useCallback(
    async (page: any) => {
      const containerW = width || containerRef.current?.clientWidth || page.getViewport({ scale: 1 }).width;
      setRenderWidth(containerW);

      // Wait for text layer to render, then read positions
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          extractWordPositionsFromTextLayer();
        });
      });
    },
    [width]
  );

  // Extract word positions from the actual rendered text layer spans
  const extractWordPositionsFromTextLayer = useCallback(() => {
    if (!containerRef.current) return;

    // Find the canvas to get its exact rendered size
    const canvas = containerRef.current.querySelector("canvas");
    if (canvas) {
      setCanvasSize({ w: canvas.clientWidth, h: canvas.clientHeight });
    }

    // Find the text layer that react-pdf renders
    const textLayer = containerRef.current.querySelector(".react-pdf__Page__textContent");
    if (!textLayer) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    // Use the canvas position as reference, not the container
    const canvasRect = canvas?.getBoundingClientRect() || containerRect;

    const spans = textLayer.querySelectorAll("span[role='presentation']") as NodeListOf<HTMLSpanElement>;
    if (spans.length === 0) {
      // Fallback: try all spans
      const allSpans = textLayer.querySelectorAll("span") as NodeListOf<HTMLSpanElement>;
      extractFromSpans(allSpans, canvasRect);
      return;
    }
    extractFromSpans(spans, canvasRect);
  }, [pageStartGlobal]);

  const extractFromSpans = useCallback((spans: NodeListOf<HTMLSpanElement>, canvasRect: DOMRect) => {
    const positions: WordPosition[] = [];
    let globalIdx = pageStartGlobal;

    for (const span of Array.from(spans)) {
      const text = span.textContent?.trim();
      if (!text) continue;

      const words = text.split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;

      const spanRect = span.getBoundingClientRect();
      const spanX = spanRect.left - canvasRect.left;
      const spanY = spanRect.top - canvasRect.top;
      const spanW = spanRect.width;
      const spanH = spanRect.height;

      if (words.length === 1) {
        positions.push({
          word: words[0],
          x: spanX,
          y: spanY,
          width: spanW,
          height: spanH,
          globalIndex: globalIdx,
        });
        globalIdx++;
      } else {
        // Distribute words proportionally across the span width
        const totalChars = words.reduce((s, w) => s + w.length, 0);
        const spaceCount = words.length - 1;
        const charUnit = spanW / (totalChars + spaceCount * 0.5);
        let xOffset = 0;

        for (const word of words) {
          const wordWidth = word.length * charUnit;
          positions.push({
            word,
            x: spanX + xOffset,
            y: spanY,
            width: wordWidth,
            height: spanH,
            globalIndex: globalIdx,
          });
          globalIdx++;
          xOffset += wordWidth + 0.5 * charUnit; // space
        }
      }
    }

    setWordPositions(positions);
  }, [pageStartGlobal]);

  // Re-extract positions on resize
  useEffect(() => {
    const timer = setTimeout(extractWordPositionsFromTextLayer, 200);
    return () => clearTimeout(timer);
  }, [renderWidth, extractWordPositionsFromTextLayer]);

  // Auto-scroll to active highlighted word during playback
  useEffect(() => {
    if (activeWordRef.current) {
      activeWordRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightedWordOnPage]);

  // Scroll to resume position on initial load
  useEffect(() => {
    if (resumeWordRef.current && !activeWordRef.current) {
      resumeWordRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [resumeWordOnPage, wordPositions]);

  return (
    <div ref={containerRef} className="pdf-page-container relative">
      <Document
        file={fileUrl}
        onLoadSuccess={(pdf) => onDocumentLoad(pdf.numPages)}
        loading={
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        }
        error={
          <div className="text-center py-12 text-destructive">
            Failed to load PDF. Please try again.
          </div>
        }
      >
        <Page
          pageNumber={pageNumber}
          width={renderWidth || containerRef.current?.clientWidth || undefined}
          renderTextLayer={true}
          renderAnnotationLayer={false}
          onLoadSuccess={handlePageLoadSuccess}
          className="pdf-native-page"
        />
      </Document>

      {/* Word highlight overlay — positioned relative to canvas */}
      {canvasSize && (
        <div
          className="absolute pointer-events-none"
          style={{
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: canvasSize.w + "px",
            height: canvasSize.h + "px",
          }}
        >
          {wordPositions.map((wp, i) => {
            const localIdx = wp.globalIndex - pageStartGlobal;
            const isActive = localIdx === highlightedWordOnPage;
            const isResume = localIdx === resumeWordOnPage && !isActive;
            const isRead = wp.globalIndex < currentWordGlobal && !isActive && !isResume;

            return (
              <div
                key={i}
                ref={isActive ? activeWordRef : isResume ? resumeWordRef : null}
                className={cn(
                  "pdf-word-overlay pointer-events-auto cursor-pointer absolute transition-all duration-150",
                  isActive && "pdf-word-active",
                  isResume && "pdf-word-resume",
                  isRead && "pdf-word-read"
                )}
                style={{
                  left: wp.x + "px",
                  top: wp.y + "px",
                  width: wp.width + "px",
                  height: wp.height + "px",
                  borderRadius: "2px",
                }}
                onClick={() => onWordClick(wp.globalIndex)}
                title={wp.word}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
