package store

// A migration is the statements that take the store to the next version,
// which is its 1-based position in migrations. Every statement must be
// additive (TestMigrationsAreAdditive) so the previous release still reads
// and writes the store.
type migration []string

var migrations = []migration{
	{
		`CREATE TABLE meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			text TEXT NOT NULL,
			ts INTEGER NOT NULL,
			author TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('chat', 'capture')),
			resolved_text TEXT
		)`,
		`CREATE TABLE topics (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('live', 'archived', 'merged', 'retracted')),
			merged_into TEXT REFERENCES topics (id),
			last_active_at INTEGER NOT NULL,
			created_by_op TEXT
		)`,
		// An explicit INTEGER PRIMARY KEY, because VACUUM may renumber an implicit rowid.
		`CREATE TABLE memberships (
			id INTEGER PRIMARY KEY,
			message_id TEXT NOT NULL REFERENCES messages (id),
			topic_id TEXT NOT NULL REFERENCES topics (id),
			source TEXT NOT NULL,
			confidence REAL,
			op_id TEXT NOT NULL,
			removed_at INTEGER,
			removed_by TEXT
		)`,
		`CREATE UNIQUE INDEX memberships_live ON memberships (message_id, topic_id) WHERE removed_at IS NULL`,
		`CREATE INDEX memberships_live_topic ON memberships (topic_id) WHERE removed_at IS NULL`,
		`CREATE INDEX memberships_op ON memberships (op_id)`,
		`CREATE INDEX memberships_removed_by ON memberships (removed_by) WHERE removed_by IS NOT NULL`,
		// Invariant I1 held by the schema itself, for every writer.
		`CREATE TRIGGER memberships_no_delete BEFORE DELETE ON memberships
		BEGIN
			SELECT RAISE(ABORT, 'memberships are append-only');
		END`,
		`CREATE TRIGGER memberships_only_removed_at BEFORE UPDATE ON memberships
		WHEN old.removed_at IS NOT NULL
			OR new.removed_at IS NULL
			OR new.id IS NOT old.id
			OR new.message_id IS NOT old.message_id
			OR new.topic_id IS NOT old.topic_id
			OR new.source IS NOT old.source
			OR new.confidence IS NOT old.confidence
			OR new.op_id IS NOT old.op_id
		BEGIN
			SELECT RAISE(ABORT, 'memberships are append-only');
		END`,
		`CREATE TABLE ops (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			undone_at INTEGER
		)`,
		`CREATE TABLE touches (
			id INTEGER PRIMARY KEY,
			topic_id TEXT NOT NULL REFERENCES topics (id),
			message_id TEXT REFERENCES messages (id),
			kind TEXT NOT NULL,
			at INTEGER NOT NULL
		)`,
		`CREATE INDEX touches_topic ON touches (topic_id, at)`,
		`CREATE TABLE summaries (
			topic_id TEXT NOT NULL REFERENCES topics (id),
			version INTEGER NOT NULL,
			text TEXT NOT NULL,
			open_items TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER NOT NULL,
			PRIMARY KEY (topic_id, version)
		)`,
		`CREATE TABLE corrections (
			id INTEGER PRIMARY KEY,
			message_id TEXT NOT NULL REFERENCES messages (id),
			resolved_text TEXT,
			wrong_topic_id TEXT REFERENCES topics (id),
			right_topic_id TEXT REFERENCES topics (id),
			op_id TEXT,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE proposals (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			decided_at INTEGER
		)`,
		`CREATE VIRTUAL TABLE messages_fts USING fts5 (body, kind UNINDEXED, ref UNINDEXED)`,
		`CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages
		BEGIN
			INSERT INTO messages_fts (body, kind, ref) VALUES (new.text, 'message', new.id);
		END`,
		`CREATE TRIGGER topics_fts_insert AFTER INSERT ON topics
		BEGIN
			INSERT INTO messages_fts (body, kind, ref) VALUES (new.title, 'topic', new.id);
		END`,
		`CREATE TRIGGER topics_fts_title AFTER UPDATE OF title ON topics
		BEGIN
			DELETE FROM messages_fts WHERE kind = 'topic' AND ref = old.id;
			INSERT INTO messages_fts (body, kind, ref) VALUES (new.title, 'topic', new.id);
		END`,
	},
}
