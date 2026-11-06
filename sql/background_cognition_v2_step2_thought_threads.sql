-- Background Cognition v2 - durable Thought Thread storage
-- Restored from the inspected production schema export and repository test contract.
--
-- IMPORTANT:
-- The production table already exists. This file is being restored to the backend
-- repository so the migration source and migration test are present.
-- Do NOT re-run this migration against the existing production database.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_thought_threads (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    agent_id text NOT NULL DEFAULT 'star',
    title text NOT NULL,
    current_draft text NOT NULL DEFAULT '',
    next_step text,
    result text,
    status text NOT NULL DEFAULT 'open',
    next_review_at timestamp with time zone,
    dedupe_key text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    version integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    closed_at timestamp with time zone,

    CONSTRAINT agent_thought_threads_pkey PRIMARY KEY (id),
    CONSTRAINT thought_threads_agent_id_chk CHECK (length(btrim(agent_id)) > 0),
    CONSTRAINT thought_threads_dedupe_chk CHECK (dedupe_key IS NULL OR (length(btrim(dedupe_key)) >= 1 AND length(btrim(dedupe_key)) <= 128)),
    CONSTRAINT thought_threads_dedupe_unique UNIQUE (user_id, agent_id, dedupe_key),
    CONSTRAINT thought_threads_draft_chk CHECK (length(current_draft) <= 6000),
    CONSTRAINT thought_threads_lifecycle_chk CHECK (
        (status = 'open' AND closed_at IS NULL AND result IS NULL)
        OR
        (status = 'completed' AND closed_at IS NOT NULL AND result IS NOT NULL AND next_step IS NULL AND next_review_at IS NULL)
        OR
        (status = 'abandoned' AND closed_at IS NOT NULL AND result IS NULL AND next_step IS NULL AND next_review_at IS NULL)
    ),
    CONSTRAINT thought_threads_metadata_chk CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT thought_threads_next_step_chk CHECK (next_step IS NULL OR length(next_step) <= 1200),
    CONSTRAINT thought_threads_result_chk CHECK (result IS NULL OR (length(btrim(result)) >= 1 AND length(btrim(result)) <= 6000)),
    CONSTRAINT thought_threads_status_chk CHECK (status = ANY (ARRAY['open', 'completed', 'abandoned'])),
    CONSTRAINT thought_threads_title_chk CHECK (length(btrim(title)) >= 1 AND length(btrim(title)) <= 160),
    CONSTRAINT thought_threads_version_chk CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_thought_threads_by_owner
    ON public.agent_thought_threads USING btree (user_id, agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_thought_threads_due
    ON public.agent_thought_threads USING btree (user_id, agent_id, next_review_at)
    WHERE status = 'open' AND next_review_at IS NOT NULL;

ALTER TABLE public.agent_thought_threads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.agent_thought_threads FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_thought_threads TO service_role;

COMMIT;
