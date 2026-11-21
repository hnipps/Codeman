package store

import (
	"os"
	"testing"
)

func TestOpenTightensExistingStoreFiles(t *testing.T) {
	path := dbPath(t)
	s := openAt(t, path, migrations)
	s.Close()
	names := []string{path, path + "-wal", path + "-shm"}
	for _, name := range names {
		f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
		if err := os.Chmod(name, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s = openAt(t, path, migrations)
	defer s.Close()
	for _, name := range names {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Fatalf("%s mode %o after open, want 600", name, mode)
		}
	}
}
