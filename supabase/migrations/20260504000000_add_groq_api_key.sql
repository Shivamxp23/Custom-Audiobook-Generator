-- Add encrypted Groq API key to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS groq_api_key TEXT;
