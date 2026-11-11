CREATE SEQUENCE IF NOT EXISTS parseable_document_version;
CREATE TABLE IF NOT EXISTS parseable_documents (
 tenant text NOT NULL, kind text NOT NULL, key text NOT NULL,
 body bytea NOT NULL,
 version bigint NOT NULL DEFAULT nextval('parseable_document_version'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant, key)
);
