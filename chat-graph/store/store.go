// Package store is Chat Graph's SQLite store: messages, topics, the
// memberships that file messages to topics, and the ops that change them.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"strconv"
	"syscall"

	_ "modernc.org/sqlite"
)

// Callers branch on these with errors.Is; the sidecar maps them to 400, 404 and 409.
var (
	ErrInvalid  = errors.New("invalid")
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict")
)

type Store struct {
	db  *sql.DB
	now func() int64
}

// Open opens or creates the store at path and applies the migrations it
// knows. now returns the time in milliseconds.
func Open(path string, now func() int64) (*Store, error) {
	return open(path, now, migrations)
}

func open(path string, now func() int64, ms []migration) (*Store, error) {
	// SQLite creates -wal and -shm lazily, after Open returns, so the umask
	// cannot be restored afterwards: it stays 077 for the process.
	syscall.Umask(0o077)
	// The umask covers files created from now on; one an earlier run left
	// readable is tightened here.
	for _, f := range []string{path, path + "-wal", path + "-shm"} {
		if err := os.Chmod(f, 0o600); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}

	q := url.Values{}
	for _, p := range []string{
		"journal_mode(WAL)",
		"foreign_keys(1)",
		"busy_timeout(5000)",
		"synchronous(NORMAL)",
		"cache_size(-8000)",
		"mmap_size(0)",
	} {
		q.Add("_pragma", p)
	}
	q.Set("_txlock", "immediate")
	db, err := sql.Open("sqlite", path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// One connection serialises every write, which is what each op's
	// read-check-write transaction relies on, and keeps one page cache.
	db.SetMaxOpenConns(1)
	if err := migrate(db, ms); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, now: now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

type querier interface {
	QueryRow(query string, args ...any) *sql.Row
}

// migrate applies, in order, the migrations newer than the store's
// schema_version. A store newer than this code is opened as it is: the
// previous release must keep reading and writing it after a rollback.
func migrate(db *sql.DB, ms []migration) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	v, err := schemaVersion(tx)
	if err != nil {
		return err
	}
	for i := v; i < len(ms); i++ {
		for _, stmt := range ms[i] {
			if _, err := tx.Exec(stmt); err != nil {
				return fmt.Errorf("migration %d: %w", i+1, err)
			}
		}
		if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, strconv.Itoa(i+1)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func schemaVersion(q querier) (int, error) {
	var n int
	if err := q.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).Scan(&n); err != nil || n == 0 {
		return 0, err
	}
	var v string
	err := q.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(v)
}

// validID admits the ids Codeman mints (UUIDs and the like). ':' is
// excluded so the op ids undo writes ("undo:<id>") never collide with one.
func validID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalid}, args...)...)
}

func conflict(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrConflict}, args...)...)
}

func notFound(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrNotFound}, args...)...)
}
