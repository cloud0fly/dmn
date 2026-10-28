CREATE TABLE node_prompts (
 node_id TEXT PRIMARY KEY REFERENCES model_nodes(node_id),
 revision INTEGER NOT NULL CHECK(revision > 0),
 system_prompt TEXT CHECK(system_prompt IS NULL OR length(system_prompt) BETWEEN 1 AND 8000),
 updated_at TEXT NOT NULL
);
CREATE TABLE node_prompt_requests (
 node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
 idempotency_key TEXT NOT NULL,
 request_json TEXT NOT NULL,
 result_json TEXT NOT NULL,
 PRIMARY KEY(node_id,idempotency_key)
);
