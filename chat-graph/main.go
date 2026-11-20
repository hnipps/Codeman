// Command chat-graph is Chat Graph's sidecar. Codeman starts it with the
// directory it owns and talks to it over a Unix socket in that directory.
// It opens no other listener and no outbound connection.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

const socketName = "sock"

func main() {
	dir := flag.String("dir", "", "directory Codeman gives the sidecar (absolute)")
	flag.Parse()

	ln, err := listen(*dir)
	if err != nil {
		log.Fatalf("chat-graph: %v", err)
	}
	srv := &http.Server{Handler: newHandler(), ReadHeaderTimeout: 5 * time.Second}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	log.Printf("chat-graph: listening on %s", ln.Addr())

	select {
	case <-stop:
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	case err := <-served:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("chat-graph: %v", err)
		}
	}
}

// listen opens <dir>/sock with mode 0600. A socket file nobody answers on is
// left over from a crash and is replaced; one that answers belongs to a live
// sidecar, and two writers on one store is what this refuses.
func listen(dir string) (net.Listener, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("--dir must be an absolute path, got %q", dir)
	}
	path := filepath.Join(dir, socketName)
	if _, err := os.Lstat(path); err == nil {
		if conn, err := net.DialTimeout("unix", path, time.Second); err == nil {
			conn.Close()
			return nil, fmt.Errorf("a sidecar already answers on %s", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", path)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func newHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}
