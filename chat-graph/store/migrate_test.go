package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// nextRelease stands in for the release after this one: the current
// migrations plus one that adds a table and a nullable column.
var nextRelease = append(slices.Clone(migrations), migration{
	`CREATE TABLE topic_notes (topic_id TEXT NOT NULL REFERENCES topics (id), note TEXT NOT NULL)`,
	`ALTER TABLE messages ADD COLUMN lang TEXT`,
})

func versionOf(t *testing.T, s *Store) int {
	t.Helper()
	v, err := schemaVersion(s.db)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// Invariant I7: PreviousReleaseReadsTheStore
func TestPreviousReleaseReadsAndWritesANewerStore(t *testing.T) {
	path := dbPath(t)

	cur := openAt(t, path, migrations)
	if v := versionOf(t, cur); v != len(migrations) {
		t.Fatalf("new store at version %d, want %d", v, len(migrations))
	}
	addMsg(t, cur, "before")
	mustApply(t, cur, `{"id":"before","kind":"route","messageId":"before","topics":[{"topicId":"a"}],"newTopics":[{"id":"a","title":"Budget"}]}`)
	cur.Close()

	next := openAt(t, path, nextRelease)
	if v := versionOf(t, next); v != len(nextRelease) {
		t.Fatalf("roll forward left version %d, want %d", v, len(nextRelease))
	}
	next.Close()

	prev := openAt(t, path, migrations)
	if v := versionOf(t, prev); v != len(nextRelease) {
		t.Fatalf("the previous release moved the version to %d, want %d kept", v, len(nextRelease))
	}
	addMsg(t, prev, "after")
	mustApply(t, prev, `{"id":"after","kind":"route","messageId":"after","topics":[{"topicId":"a"},{"topicId":"b"}],"newTopics":[{"id":"b","title":"Travel"}]}`)
	mustApply(t, prev, `{"id":"op-move","kind":"move","messageId":"before","from":"a","to":"b"}`)
	if _, err := prev.Undo("op-move"); err != nil {
		t.Fatalf("the previous release could not undo on a newer store: %v", err)
	}
	a, err := prev.Topic("a")
	if err != nil || !reflect.DeepEqual(a.MessageIDs, []string{"after", "before"}) {
		t.Fatalf("previous release read topic a as %+v, %v", a, err)
	}
	prev.Close()

	next = openAt(t, path, nextRelease)
	defer next.Close()
	b, err := next.Topic("b")
	if err != nil || !reflect.DeepEqual(b.MessageIDs, []string{"after"}) {
		t.Fatalf("next release read topic b as %+v, %v", b, err)
	}
	var lang sql.NullString
	if err := next.db.QueryRow(`SELECT lang FROM messages WHERE id = 'after'`).Scan(&lang); err != nil || lang.Valid {
		t.Fatalf("next release read the previous release's row: lang %v, %v", lang, err)
	}
	if _, err := next.db.Exec(`INSERT INTO topic_notes (topic_id, note) VALUES ('b', 'n')`); err != nil {
		t.Fatalf("next release's own table: %v", err)
	}
}

var addColumn = regexp.MustCompile(`^ALTER TABLE \S+ ADD COLUMN `)

// additive reports why stmt could stop the previous release reading the store.
func additive(stmt string) error {
	s := strings.ToUpper(strings.Join(strings.Fields(stmt), " "))
	for _, ok := range []string{"CREATE TABLE ", "CREATE INDEX ", "CREATE UNIQUE INDEX ", "CREATE VIRTUAL TABLE ", "CREATE TRIGGER "} {
		if strings.HasPrefix(s, ok) {
			return nil
		}
	}
	if addColumn.MatchString(s) {
		if strings.Contains(s, "NOT NULL") && !strings.Contains(s, "DEFAULT") {
			return fmt.Errorf("NOT NULL column without a DEFAULT: %s", stmt)
		}
		return nil
	}
	return fmt.Errorf("not additive: %s", stmt)
}

// Invariant I7: PreviousReleaseReadsTheStore
func TestMigrationsAreAdditive(t *testing.T) {
	for _, bad := range []string{
		"DROP TABLE messages",
		"ALTER TABLE messages RENAME TO msgs",
		"ALTER TABLE messages DROP COLUMN author",
		"ALTER TABLE messages ADD COLUMN lang TEXT NOT NULL",
		"UPDATE meta SET value = '1'",
	} {
		if additive(bad) == nil {
			t.Fatalf("the check admitted %q", bad)
		}
	}
	if err := additive("ALTER TABLE messages ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'"); err != nil {
		t.Fatal(err)
	}
	for i, m := range nextRelease {
		for _, stmt := range m {
			if err := additive(stmt); err != nil {
				t.Errorf("migration %d: %v", i+1, err)
			}
		}
	}
}

var bareInsert = regexp.MustCompile(`(?i)INSERT\s+INTO\s+\w+\s+(VALUES|SELECT|DEFAULT)`)

// Invariant I7: PreviousReleaseReadsTheStore
// An INSERT that names no columns breaks as soon as a later release adds one.
func TestEveryInsertNamesItsColumns(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	var checked int
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		if m := bareInsert.Find(src); m != nil {
			t.Errorf("%s: %q names no columns", f, m)
		}
	}
	if checked == 0 || bareInsert.FindString("insert into messages values (1)") == "" {
		t.Fatal("the check saw nothing")
	}
}
