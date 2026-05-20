-- Store extracted page text for server-side audio generation
CREATE TABLE IF NOT EXISTS public.book_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(book_id, page_number)
);

ALTER TABLE public.book_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own book pages" ON public.book_pages
  FOR SELECT USING (
    book_id IN (SELECT id FROM public.books WHERE user_id = auth.uid())
  );

CREATE POLICY "Users can insert own book pages" ON public.book_pages
  FOR INSERT WITH CHECK (
    book_id IN (SELECT id FROM public.books WHERE user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_book_pages_book ON public.book_pages(book_id, page_number);

-- Add priority column to page_audio_cache for queue ordering
ALTER TABLE public.page_audio_cache ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
