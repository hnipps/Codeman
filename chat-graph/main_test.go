package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "cg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func client(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", path)
		},
	}}
}

func TestHealthOnPrivateSocket(t *testing.T) {
	dir := shortDir(t)
	ln, err := listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: newHandler()}
	go srv.Serve(ln)
	defer srv.Close()

	path := filepath.Join(dir, socketName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("socket mode %o, want 600", mode)
	}

	res, err := client(path).Get("http://chat-graph/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != fmt.Sprintf(`{"ok":true,"pid":%d}`, os.Getpid()) {
		t.Fatalf("health answered %d %s", res.StatusCode, body)
	}
}

func TestRefusesRelativeDir(t *testing.T) {
	for _, dir := range []string{"", "relative/dir"} {
		if ln, err := listen(dir); err == nil {
			ln.Close()
			t.Fatalf("listen(%q) succeeded", dir)
		}
	}
}

func TestRefusesSecondSidecar(t *testing.T) {
	dir := shortDir(t)
	first, err := listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := listen(dir); err == nil {
		second.Close()
		t.Fatal("a second sidecar took the socket of a live one")
	}
}

func TestReplacesStaleSocket(t *testing.T) {
	dir := shortDir(t)
	path := filepath.Join(dir, socketName)
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()

	ln, err := listen(dir)
	if err != nil {
		t.Fatalf("stale socket was not replaced: %v", err)
	}
	ln.Close()
}

func TestLockRefusesSecondSidecarBeforeTheSocketExists(t *testing.T) {
	dir := shortDir(t)
	first, err := listen(dir)
	if err != nil {
		t.Fatal(err)
	}
	// A racing sidecar that saw no answer would remove the socket; the lock must stop it first.
	if err := os.Remove(filepath.Join(dir, socketName)); err != nil {
		t.Fatal(err)
	}
	if second, err := listen(dir); err == nil {
		second.Close()
		first.Close()
		t.Fatal("a second sidecar listened while the first held the lock")
	}
	first.Close()
	again, err := listen(dir)
	if err != nil {
		t.Fatalf("the lock was not released on close: %v", err)
	}
	again.Close()
}
