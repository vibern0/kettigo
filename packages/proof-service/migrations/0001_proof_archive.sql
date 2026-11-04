CREATE TABLE namespaces (chain_id TEXT NOT NULL, pool TEXT NOT NULL, depth INTEGER NOT NULL, zero_handle TEXT NOT NULL, empty_hashes_json TEXT NOT NULL, deployment_block INTEGER NOT NULL, PRIMARY KEY(chain_id,pool));
CREATE TABLE canonical_blocks (chain_id TEXT NOT NULL, pool TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, parent_hash TEXT NOT NULL, PRIMARY KEY(chain_id,pool,block_number));
CREATE TABLE event_logs (chain_id TEXT NOT NULL, pool TEXT NOT NULL, block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(chain_id,pool,block_number,log_index));
CREATE TABLE node_versions (chain_id TEXT NOT NULL,pool TEXT NOT NULL,level INTEGER NOT NULL,node_index TEXT NOT NULL,block_number INTEGER NOT NULL,log_index INTEGER NOT NULL,hash TEXT NOT NULL,sum_handle TEXT NOT NULL,PRIMARY KEY(chain_id,pool,block_number,log_index));
CREATE INDEX node_versions_at ON node_versions(chain_id,pool,level,node_index,block_number DESC,log_index DESC);
CREATE TABLE slot_versions (chain_id TEXT NOT NULL,pool TEXT NOT NULL,account TEXT NOT NULL,slot_index TEXT NOT NULL,generation TEXT NOT NULL,assigned INTEGER NOT NULL,block_number INTEGER NOT NULL,log_index INTEGER NOT NULL,PRIMARY KEY(chain_id,pool,block_number,log_index));
CREATE INDEX slot_account_at ON slot_versions(chain_id,pool,account,block_number DESC,log_index DESC);
CREATE INDEX slot_index_at ON slot_versions(chain_id,pool,slot_index,block_number DESC,log_index DESC);
CREATE TABLE draws (chain_id TEXT NOT NULL,pool TEXT NOT NULL,draw_id TEXT NOT NULL,root_hash TEXT NOT NULL,root_sum TEXT NOT NULL,ticket_handle TEXT NOT NULL,upper_bound_handle TEXT NOT NULL,close_block_number INTEGER NOT NULL,close_log_index INTEGER NOT NULL,PRIMARY KEY(chain_id,pool,draw_id),UNIQUE(chain_id,pool,close_block_number,close_log_index));
CREATE TABLE ingestion_state (chain_id TEXT NOT NULL,pool TEXT NOT NULL,next_block INTEGER NOT NULL,last_finalized_block INTEGER NOT NULL,last_finalized_hash TEXT NOT NULL,revision INTEGER NOT NULL,disabled_reason TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(chain_id,pool));
CREATE TABLE ingestion_commits (chain_id TEXT NOT NULL,pool TEXT NOT NULL,previous_revision INTEGER NOT NULL,kind TEXT NOT NULL,from_block INTEGER NOT NULL,to_block INTEGER NOT NULL,committed_at TEXT NOT NULL,PRIMARY KEY(chain_id,pool,previous_revision));
CREATE TRIGGER require_current_revision BEFORE INSERT ON ingestion_commits BEGIN
  SELECT CASE WHEN (SELECT revision FROM ingestion_state WHERE chain_id=NEW.chain_id AND pool=NEW.pool) != NEW.previous_revision THEN RAISE(ABORT,'checkpoint conflict') END;
END;
