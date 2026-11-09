-- Dedicated private dispatch; scheduling is enabled only after verified cutover.
CREATE FUNCTION gallabox_private.dispatch_capture() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE secret text; request_id bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gallabox_private.worker_control WHERE singleton AND enabled AND writer_mode='cloud') THEN RETURN NULL; END IF;
 SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name='gallabox_capture_trigger' LIMIT 1;
 IF secret IS NULL THEN RAISE EXCEPTION 'Missing capture trigger'; END IF;
 SELECT net.http_post(url:='https://trhhjfgfmxofxhnzocks.supabase.co/functions/v1/gallabox-capture',headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||secret),body:='{}'::jsonb,timeout_milliseconds:=60000) INTO request_id;
 RETURN request_id;
END $$;
REVOKE ALL ON FUNCTION gallabox_private.dispatch_capture() FROM PUBLIC,anon,authenticated;
