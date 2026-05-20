
-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles viewable by owner" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

-- Books
CREATE TABLE public.books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf','epub')),
  file_path TEXT NOT NULL,
  cover_url TEXT,
  total_pages INTEGER DEFAULT 0,
  total_words INTEGER DEFAULT 0,
  current_page INTEGER NOT NULL DEFAULT 1,
  current_word_index INTEGER NOT NULL DEFAULT 0,
  total_read_seconds INTEGER NOT NULL DEFAULT 0,
  voice_id TEXT,
  voice_description TEXT,
  tts_status TEXT NOT NULL DEFAULT 'pending' CHECK (tts_status IN ('pending','generating','ready','error')),
  tts_progress INTEGER NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Books select own" ON public.books FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Books insert own" ON public.books FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Books update own" ON public.books FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Books delete own" ON public.books FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_books_user ON public.books(user_id);

-- Audio chunks
CREATE TABLE public.audio_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  page_number INTEGER NOT NULL,
  start_word_index INTEGER NOT NULL,
  end_word_index INTEGER NOT NULL,
  text_content TEXT NOT NULL,
  audio_path TEXT,
  duration_seconds NUMERIC,
  word_timings JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.audio_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Chunks select own" ON public.audio_chunks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Chunks insert own" ON public.audio_chunks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Chunks update own" ON public.audio_chunks FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Chunks delete own" ON public.audio_chunks FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_chunks_book ON public.audio_chunks(book_id, chunk_index);

-- Reading sessions
CREATE TABLE public.reading_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  start_page INTEGER,
  end_page INTEGER,
  pages_read INTEGER DEFAULT 0
);
ALTER TABLE public.reading_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Sessions select own" ON public.reading_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Sessions insert own" ON public.reading_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Sessions update own" ON public.reading_sessions FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Sessions delete own" ON public.reading_sessions FOR DELETE USING (auth.uid() = user_id);
CREATE INDEX idx_sessions_user ON public.reading_sessions(user_id, started_at DESC);

-- Timestamp trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_books_updated BEFORE UPDATE ON public.books FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Storage buckets
INSERT INTO storage.buckets (id, name, public) VALUES ('books', 'books', false);
INSERT INTO storage.buckets (id, name, public) VALUES ('audio', 'audio', false);

-- Books bucket policies (user folder = first segment)
CREATE POLICY "Books own select" ON storage.objects FOR SELECT
USING (bucket_id = 'books' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Books own insert" ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'books' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Books own update" ON storage.objects FOR UPDATE
USING (bucket_id = 'books' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Books own delete" ON storage.objects FOR DELETE
USING (bucket_id = 'books' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Audio own select" ON storage.objects FOR SELECT
USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Audio own insert" ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Audio own update" ON storage.objects FOR UPDATE
USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Audio own delete" ON storage.objects FOR DELETE
USING (bucket_id = 'audio' AND auth.uid()::text = (storage.foldername(name))[1]);
