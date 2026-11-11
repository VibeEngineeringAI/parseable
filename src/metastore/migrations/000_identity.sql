CREATE TABLE IF NOT EXISTS parseable_backend (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 id text NOT NULL, bucket text NOT NULL, schema_version integer NOT NULL,
 protocol_version integer NOT NULL
);
