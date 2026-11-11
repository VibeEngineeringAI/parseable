-- The caller holds the shared transaction advisory lock. ALTER rebuilds the
-- populated primary key transactionally; existing rows and versions survive.
ALTER TABLE parseable_documents ALTER COLUMN key TYPE text COLLATE "C";
CREATE INDEX IF NOT EXISTS parseable_stream_inventory ON parseable_documents (tenant,key) WHERE key LIKE '%/.stream/%';
CREATE OR REPLACE FUNCTION parseable_admit_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stream_prefix text;
BEGIN
  IF position('/.stream/' in NEW.key) > 0 THEN
    stream_prefix := split_part(NEW.key, '/.stream/', 1);
    -- Serialize marker and stream writes, including writers on other nodes.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant || '/' || stream_prefix, 0));
    IF NEW.key NOT LIKE '%/.deleting' AND EXISTS (
      SELECT 1 FROM parseable_documents WHERE tenant=NEW.tenant AND key=stream_prefix || '/.stream/.deleting'
    ) THEN RAISE EXCEPTION 'stream deletion pending'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS parseable_admit_document ON parseable_documents;
CREATE TRIGGER parseable_admit_document BEFORE INSERT OR UPDATE ON parseable_documents FOR EACH ROW EXECUTE FUNCTION parseable_admit_document();
UPDATE parseable_backend SET schema_version=2 WHERE singleton;
