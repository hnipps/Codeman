package store

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type clock struct{ n int64 }

func (c *clock) now() int64 { c.n++; return c.n }

func dbPath(t *testing.T) string { return filepath.Join(t.TempDir(), "graph.sqlite") }

func openAt(t *testing.T, path string, ms []migration) *Store {
	t.Helper()
	s, err := open(path, (&clock{n: 1000}).now, ms)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func addMsg(t *testing.T, s *Store, id string) {
	t.Helper()
	if err := s.AddMessage(Message{ID: id, Text: "text of " + id, TS: 1, Author: "harry", Kind: KindChat}); err != nil {
		t.Fatal(err)
	}
}

func mustParse(t *testing.T, body string) Op {
	t.Helper()
	op, err := ParseOp([]byte(body))
	if err != nil {
		t.Fatalf("ParseOp(%s): %v", body, err)
	}
	return op
}

func mustApply(t *testing.T, s *Store, body string) OpResult {
	t.Helper()
	res, err := s.Apply(mustParse(t, body))
	if err != nil {
		t.Fatalf("Apply(%s): %v", body, err)
	}
	return res
}

// dump renders every table, FTS shadow tables included, in a stable order.
func dump(t *testing.T, s *Store) string {
	t.Helper()
	rows, err := s.db.Query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		tables = append(tables, n)
	}
	rows.Close()
	return dumpTables(t, s, tables)
}

func dumpTables(t *testing.T, s *Store, tables []string) string {
	t.Helper()
	var b strings.Builder
	for _, name := range tables {
		r, err := s.db.Query(`SELECT * FROM "` + name + `"`)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := r.Columns()
		var lines []string
		for r.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := r.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			for i, v := range vals {
				if b, ok := v.([]byte); ok {
					vals[i] = string(b)
				}
			}
			lines = append(lines, fmt.Sprintf("%v", vals))
		}
		r.Close()
		sort.Strings(lines)
		fmt.Fprintf(&b, "== %s\n%s\n", name, strings.Join(lines, "\n"))
	}
	return b.String()
}
