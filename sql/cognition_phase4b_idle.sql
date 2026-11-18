-- Phase 4B: persistent, unified conversation idle scanner.
-- Run on the actual Supabase SQL Editor only after checking the current schema.
-- No model calls. Creates no historical events on first scan.
BEGIN;

CREATE TABLE IF NOT EXISTS public.cognition_phase4b_idle_state (
    user_id uuid NOT NULL,
    agent_id text NOT NULL CHECK (agent_id = 'star'),
    armed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_queued_key text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, agent_id)
);
ALTER TABLE public.cognition_phase4b_idle_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cognition_phase4b_idle_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cognition_phase4b_idle_state TO service_role;

-- Existing chat and call tables are treated as the source of truth.
-- We do not add triggers to existing chat or voice paths.
CREATE INDEX IF NOT EXISTS cognition_phase4b_messages_activity_idx
ON public.messages(user_id, created_at DESC, id DESC)
WHERE role IN ('user','assistant') AND (channel IN ('text','voice') OR channel IS NULL);

CREATE INDEX IF NOT EXISTS cognition_phase4b_calls_activity_idx
ON public.call_sessions(user_id, agent_key, ended_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.cognition_phase4b_scan_idle(
    p_user_id uuid, p_agent_id text, p_idle_minutes integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
    v_armed_at timestamptz;
    v_newly_armed boolean := false;
    v_msg_id text;
    v_msg_at timestamptz;
    v_call_id text;
    v_call_at timestamptz;
    v_last_at timestamptz;
    v_now timestamptz := clock_timestamp();
    v_key text;
    v_id uuid;
    v_status text;
    v_call_active boolean;
BEGIN
    IF p_user_id IS NULL OR p_agent_id IS DISTINCT FROM 'star' OR
       p_idle_minutes IS NULL OR p_idle_minutes < 5 OR p_idle_minutes > 180 THEN
        RAISE EXCEPTION 'INVALID_PHASE4B_SCAN_INPUT';
    END IF;

    INSERT INTO public.cognition_phase4b_idle_state(user_id,agent_id,armed_at)
    VALUES(p_user_id,p_agent_id,v_now)
    ON CONFLICT (user_id,agent_id) DO NOTHING
    RETURNING armed_at INTO v_armed_at;
    IF FOUND THEN
        -- First invocation establishes a watermark; old conversations are ignored.
        RETURN jsonb_build_object('status','armed');
    END IF;
    SELECT armed_at INTO v_armed_at
    FROM public.cognition_phase4b_idle_state
    WHERE user_id=p_user_id AND agent_id=p_agent_id FOR UPDATE;

    SELECT EXISTS (
        SELECT 1 FROM public.call_sessions
        WHERE user_id=p_user_id AND agent_key='xingxing' AND ended_at IS NULL
    ) INTO v_call_active;
    IF v_call_active THEN
        RETURN jsonb_build_object('status','voice_active');
    END IF;

    SELECT id::text, created_at INTO v_msg_id,v_msg_at
    FROM public.messages
    WHERE user_id=p_user_id AND role IN ('user','assistant')
      AND (channel IN ('text','voice') OR channel IS NULL)
      AND visible IS DISTINCT FROM false
    ORDER BY created_at DESC,id DESC LIMIT 1;

    SELECT id::text, ended_at INTO v_call_id,v_call_at
    FROM public.call_sessions
    WHERE user_id=p_user_id AND agent_key='xingxing' AND ended_at IS NOT NULL
    ORDER BY ended_at DESC,id DESC LIMIT 1;

    v_last_at := greatest(coalesce(v_msg_at,'-infinity'::timestamptz),
                          coalesce(v_call_at,'-infinity'::timestamptz));
    IF v_last_at = '-infinity'::timestamptz OR v_last_at <= v_armed_at THEN
        RETURN jsonb_build_object('status','no_new_activity');
    END IF;
    IF v_last_at > v_now - make_interval(mins => p_idle_minutes) THEN
        RETURN jsonb_build_object('status','not_idle');
    END IF;
    -- A long-disconnected scanner must not emit old conversations as fresh events.
    IF v_last_at < v_now - interval '24 hours' THEN
        RETURN jsonb_build_object('status','too_old');
    END IF;

    v_key := 'phase4b-chat:' || md5(concat_ws('|',
        coalesce(v_msg_id,''), coalesce(v_msg_at::text,''),
        coalesce(v_call_id,''), coalesce(v_call_at::text,'')));

    INSERT INTO public.cognition_phase4_event_queue
        (user_id,agent_id,event_type,event_key)
    VALUES(p_user_id,p_agent_id,'chat_finished',v_key)
    ON CONFLICT(user_id,agent_id,event_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
        SELECT id, status INTO v_id, v_status
        FROM public.cognition_phase4_event_queue
        WHERE user_id=p_user_id AND agent_id=p_agent_id AND event_key=v_key;
        IF v_id IS NULL THEN RAISE EXCEPTION 'PHASE4B_EVENT_CONFLICT'; END IF;
        RETURN jsonb_build_object('status','already_queued','event_id',v_id);
    END IF;
    UPDATE public.cognition_phase4b_idle_state
        SET last_queued_key=v_key, updated_at=v_now
    WHERE user_id=p_user_id AND agent_id=p_agent_id;
    RETURN jsonb_build_object('status','queued','event_id',v_id);
END;
$$;

-- Phase 4A claim RPC compatibility: expose the stable event key to the worker.
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
    'lease_token',v_token,'attempts',v_row.attempts,
    'event_key',v_row.event_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cognition_phase4_claim_event(uuid,text)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cognition_phase4_claim_event(uuid,text)
    TO service_role;

-- Guard a *claimed* Phase4B event just before beginning model cognition.
-- If the conversation resumed or a voice call is active, consume the stale
-- event as a non-executed skip. The same event will never replay.
CREATE OR REPLACE FUNCTION public.cognition_phase4b_guard_claim(
    p_event_id uuid, p_lease_token uuid, p_idle_minutes integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
    v_event public.cognition_phase4_event_queue%ROWTYPE;
    v_msg_id text;
    v_msg_at timestamptz;
    v_call_id text;
    v_call_at timestamptz;
    v_last_at timestamptz;
    v_now timestamptz := clock_timestamp();
    v_key text;
    v_call_active boolean;
BEGIN
    IF p_event_id IS NULL OR p_lease_token IS NULL OR
       p_idle_minutes IS NULL OR p_idle_minutes < 5 OR p_idle_minutes > 180 THEN
        RAISE EXCEPTION 'INVALID_PHASE4B_GUARD_INPUT';
    END IF;
    SELECT * INTO v_event FROM public.cognition_phase4_event_queue
    WHERE id=p_event_id AND status='claimed' AND lease_token=p_lease_token
    FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','stale'); END IF;
    IF v_event.lease_until IS NULL OR v_event.lease_until <= v_now THEN
        UPDATE public.cognition_phase4_event_queue SET
            status='uncertain', result_code='lease_expired',
            lease_token=NULL,lease_until=NULL,settled_at=v_now,updated_at=v_now
        WHERE id=v_event.id;
        RETURN jsonb_build_object('status','stale');
    END IF;
    IF v_event.event_type <> 'chat_finished' OR
       v_event.event_key NOT LIKE 'phase4b-chat:%' THEN
        RETURN jsonb_build_object('status','allowed');
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM public.call_sessions
        WHERE user_id=v_event.user_id AND agent_key='xingxing' AND ended_at IS NULL
    ) INTO v_call_active;
    SELECT id::text, created_at INTO v_msg_id,v_msg_at
    FROM public.messages
    WHERE user_id=v_event.user_id AND role IN ('user','assistant')
      AND (channel IN ('text','voice') OR channel IS NULL)
      AND visible IS DISTINCT FROM false
    ORDER BY created_at DESC,id DESC LIMIT 1;
    SELECT id::text, ended_at INTO v_call_id,v_call_at
    FROM public.call_sessions
    WHERE user_id=v_event.user_id AND agent_key='xingxing' AND ended_at IS NOT NULL
    ORDER BY ended_at DESC,id DESC LIMIT 1;
    v_last_at := greatest(coalesce(v_msg_at,'-infinity'::timestamptz),
                          coalesce(v_call_at,'-infinity'::timestamptz));
    v_key := 'phase4b-chat:' || md5(concat_ws('|',
        coalesce(v_msg_id,''), coalesce(v_msg_at::text,''),
        coalesce(v_call_id,''), coalesce(v_call_at::text,'')));
    IF NOT v_call_active AND v_key=v_event.event_key AND
       v_last_at <= v_now - make_interval(mins => p_idle_minutes) AND
       v_last_at >= v_now - interval '24 hours' THEN
        RETURN jsonb_build_object('status','allowed');
    END IF;
    UPDATE public.cognition_phase4_event_queue SET
        status='done', result_code='superseded_by_activity',
        lease_token=NULL,lease_until=NULL,settled_at=v_now,updated_at=v_now
    WHERE id=v_event.id;
    RETURN jsonb_build_object('status','skipped');
END;
$$;

REVOKE ALL ON FUNCTION public.cognition_phase4b_scan_idle(uuid,text,integer)
    FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.cognition_phase4b_guard_claim(uuid,uuid,integer)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cognition_phase4b_scan_idle(uuid,text,integer)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.cognition_phase4b_guard_claim(uuid,uuid,integer)
    TO service_role;
COMMIT;
