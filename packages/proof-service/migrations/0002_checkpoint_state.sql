DROP TRIGGER require_current_revision;
CREATE TRIGGER require_current_revision BEFORE INSERT ON ingestion_commits BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ingestion_state WHERE chain_id=NEW.chain_id AND pool=NEW.pool)
    OR (SELECT revision FROM ingestion_state WHERE chain_id=NEW.chain_id AND pool=NEW.pool) IS NOT NEW.previous_revision
    THEN RAISE(ABORT,'checkpoint conflict') END;
END;
