-- Hermit Cognition Phase 4A durable event foundation.
-- Intended for Supabase SQL Editor after review and DB backup.
-- This migration is NOT applied by simply extracting the ZIP.
-- Only server-side service_role may call the RPCs; RLS enabled.
BEGIN;

CREATE TABLE IF NOT EXISTS public.cognition_phase4_event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  agent_id text NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('chat_finished','milestone_transition','external_event')
  ),
  event_key varchar(160) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending','claimed','done','uncertain')
  ),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  result_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (user_id,agent_id,event_key),
  CHECK (agent_id='star'),
  CHECK (length(event_key)>0),
  CHECK (status<>'claimed' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cognition_phase4_queue_pending_idx
ON public.cognition_phase4_event_queue(user_id,agent_id,available_at,created_at)
WHERE status='pending';

CREATE TABLE IF NOT EXISTS public.cognition_phase4_event_clock (
  user_id uuid NOT NULL,
  agent_id text NOT NULL,
  last_started_at timestamptz,
  PRIMARY KEY(user_id,agent_id),
  CHECK (agent_id='star')
);

ALTER TABLE public.cognition_phase4_event_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cognition_phase4_event_clock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cognition_phase4_event_queue FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cognition_phase4_event_clock FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cognition_phase4_event_queue TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.cognition_phase4_event_clock TO service_role;

CREATE OR REPLACE FUNCTION public.cognition_phase4_enqueue_event(
  p_user_id uuid, p_agent_id text, p_event_type text, p_event_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_row public.cognition_phase4_event_queue%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_agent_id <> 'star' OR
     p_event_type NOT IN ('chat_finished','milestone_transition','external_event') OR
     p_event_key IS NULL OR length(p_event_key)<1 OR length(p_event_key)>160 OR
     p_event_key<>btrim(p_event_key) OR
     p_event_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'INVALID_EVENT_INPUT';
  END IF;

  INSERT INTO public.cognition_phase4_event_queue
     (user_id,agent_id,event_type,event_key)
  VALUES (p_user_id,p_agent_id,p_event_type,p_event_key)
  ON CONFLICT (user_id,agent_id,event_key) DO NOTHING;

  SELECT * INTO v_row FROM public.cognition_phase4_event_queue
    WHERE user_id=p_user_id AND agent_id=p_agent_id AND event_key=p_event_key;
  IF NOT FOUND OR v_row.event_type<>p_event_type THEN
    RAISE EXCEPTION 'EVENT_KEY_TYPE_CONFLICT';
  END IF;
  RETURN jsonb_build_object('id',v_row.id,'status',v_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.cognition_phase4_claim_event(
  p_user_id uuid, p_agent_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_last timestamptz;
  v_row public.cognition_phase4_event_queue%ROWTYPE;
  v_token uuid;
BEGIN
  IF p_user_id IS NULL OR p_agent_id<>'star' THEN
    RAISE EXCEPTION 'INVALID_EVENT_IDENTITY';
  END IF;

  -- A lost worker may have stored a Thought or Thread before exiting.
  -- Expired claims become uncertain, NEVER pending (no silent replay).
  UPDATE public.cognition_phase4_event_queue SET
     status='uncertain',result_code='lease_expired',
     lease_token=NULL,lease_until=NULL,settled_at=v_now,updated_at=v_now
  WHERE user_id=p_user_id AND agent_id=p_agent_id
    AND status='claimed' AND lease_until<=v_now;

  INSERT INTO public.cognition_phase4_event_clock (user_id,agent_id,last_started_at)
  VALUES(p_user_id,p_agent_id,NULL)
  ON CONFLICT (user_id,agent_id) DO NOTHING;

  -- Row lock serializes all queue claims and the separate 60m event clock.
  SELECT last_started_at INTO v_last FROM public.cognition_phase4_event_clock
    WHERE user_id=p_user_id AND agent_id=p_agent_id FOR UPDATE;

  IF v_last IS NOT NULL AND v_last>v_now-interval '60 minutes' THEN
    RETURN jsonb_build_object('status','cooldown');
  END IF;

  SELECT * INTO v_row FROM public.cognition_phase4_event_queue
  WHERE user_id=p_user_id AND agent_id=p_agent_id
    AND status='pending' AND available_at<=v_now
  ORDER BY available_at,created_at,id
  FOR UPDATE SKIP LOCKED LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','empty');
  END IF;

  v_token:=gen_random_uuid();
  UPDATE public.cognition_phase4_event_queue
  SET status='claimed',attempts=attempts+1,
      lease_token=v_token,lease_until=v_now+interval '5 minutes',
      updated_at=v_now
  WHERE id=v_row.id
  RETURNING * INTO v_row;

  UPDATE public.cognition_phase4_event_clock
  SET last_started_at=v_now
  WHERE user_id=p_user_id AND agent_id=p_agent_id;

  RETURN jsonb_build_object(
    'status','claimed','id',v_row.id,'event_type',v_row.event_type,
    'lease_token',v_token,'attempts',v_row.attempts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.cognition_phase4_settle_event(
  p_event_id uuid, p_lease_token uuid, p_result text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_now timestamptz:=clock_timestamp();
  v_status text;
BEGIN
  IF p_event_id IS NULL OR p_lease_token IS NULL OR
     p_result NOT IN ('done','defer','uncertain') THEN
    RAISE EXCEPTION 'INVALID_EVENT_SETTLEMENT';
  END IF;
  UPDATE public.cognition_phase4_event_queue
  SET status=CASE
        WHEN lease_until<=v_now THEN 'uncertain'
        WHEN p_result='defer' THEN 'pending'
        WHEN p_result='done' THEN 'done'
        ELSE 'uncertain' END,
      available_at=CASE WHEN lease_until>v_now AND p_result='defer'
          THEN v_now+interval '5 minutes' ELSE available_at END,
      result_code=CASE WHEN lease_until<=v_now
          THEN 'lease_expired' ELSE p_result END,
      lease_token=NULL,lease_until=NULL,
      updated_at=v_now,
      settled_at=CASE WHEN lease_until>v_now AND p_result='defer'
        THEN NULL ELSE v_now END
  WHERE id=p_event_id AND lease_token=p_lease_token AND status='claimed'
  RETURNING status INTO v_status;

  IF NOT FOUND THEN RETURN jsonb_build_object('status','stale'); END IF;
  RETURN jsonb_build_object('status',v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.cognition_phase4_enqueue_event(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cognition_phase4_claim_event(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cognition_phase4_settle_event(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cognition_phase4_enqueue_event(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cognition_phase4_claim_event(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cognition_phase4_settle_event(uuid,uuid,text) TO service_role;

COMMIT;
