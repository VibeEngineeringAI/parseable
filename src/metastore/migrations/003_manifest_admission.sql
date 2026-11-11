-- Serialized by the startup advisory lock; replacement preserves populated rows.
CREATE OR REPLACE FUNCTION parseable_admit_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stream_prefix text;
BEGIN
  IF position('/.stream/' in NEW.key) > 0 THEN
    stream_prefix := split_part(NEW.key, '/.stream/', 1);
  ELSIF NEW.kind = 'manifest' AND position('/date=' in NEW.key) > 0 THEN
    stream_prefix := split_part(NEW.key, '/date=', 1);
  END IF;
  IF stream_prefix IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant || '/' || stream_prefix, 0));
    IF NEW.key NOT LIKE '%/.deleting' AND EXISTS (
      SELECT 1 FROM parseable_documents WHERE tenant=NEW.tenant AND key=stream_prefix || '/.stream/.deleting'
    ) THEN RAISE EXCEPTION 'stream deletion pending'; END IF;
  END IF;
  RETURN NEW;
END $$;
UPDATE parseable_backend SET schema_version=3 WHERE singleton;
