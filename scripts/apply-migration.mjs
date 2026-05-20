/**
 * Run this script to apply the page_audio_cache migration to your Supabase database.
 * 
 * Usage: Open https://supabase.com/dashboard/project/ukyhbkswwltizwhmbdgh/sql/new
 * and paste the SQL from supabase/migrations/20260520000000_add_page_audio_cache.sql
 * 
 * OR run: npx supabase login && npx supabase db push
 */

console.log(`
=================================================================
  APPLY THIS MIGRATION TO YOUR SUPABASE DATABASE
=================================================================

Option 1: Run in Supabase SQL Editor
  1. Go to: https://supabase.com/dashboard/project/ukyhbkswwltizwhmbdgh/sql/new
  2. Paste the following SQL and click "Run":

---
CREATE TABLE IF NOT EXISTS public.page_audio_cache (
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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'page_audio_cache' AND policyname = 'Cache select own') THEN
    CREATE POLICY "Cache select own" ON public.page_audio_cache FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'page_audio_cache' AND policyname = 'Cache insert own') THEN
    CREATE POLICY "Cache insert own" ON public.page_audio_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'page_audio_cache' AND policyname = 'Cache update own') THEN
    CREATE POLICY "Cache update own" ON public.page_audio_cache FOR UPDATE USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'page_audio_cache' AND policyname = 'Cache delete own') THEN
    CREATE POLICY "Cache delete own" ON public.page_audio_cache FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_page_audio_book ON public.page_audio_cache(book_id, page_number);
---

Option 2: Use Supabase CLI
  npx supabase login
  npx supabase link --project-ref ukyhbkswwltizwhmbdgh
  npx supabase db push

=================================================================
`);
