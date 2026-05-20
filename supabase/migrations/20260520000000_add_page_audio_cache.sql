-- Page-level audio cache for background pre-generation
CREATE TABLE public.page_audio_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  voice TEXT NOT NULL,
  audio_storage_path TEXT NOT NULL DEFAULT '',
  duration_seconds NUMERIC,
  word_timings JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','generating','ready','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(book_id, page_number, voice)
);

ALTER TABLE public.page_audio_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Cache select own" ON public.page_audio_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Cache insert own" ON public.page_audio_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Cache update own" ON public.page_audio_cache FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Cache delete own" ON public.page_audio_cache FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_page_audio_book ON public.page_audio_cache(book_id, page_number);
