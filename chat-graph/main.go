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

	"codeman/chat-graph/store"
)

const (
	socketName = "sock"
	lockName   = "lock"
	storeName  = "graph.sqlite"
)

func main() {
	dir := flag.String("dir", "", "directory Codeman gives the sidecar (absolute)")
	flag.Parse()

	ln, err := listen(*dir)
	if err != nil {
		log.Fatalf("chat-graph: %v", err)
	}
	st, err := store.Open(filepath.Join(*dir, storeName), func() int64 { return time.Now().UnixMilli() })
	if err != nil {
		ln.Close()
		log.Fatalf("chat-graph: open store: %v", err)
	}
	defer st.Close()
	srv := &http.Server{Handler: newHandler(st), ReadHeaderTimeout: 5 * time.Second}

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
			st.Close()
			log.Fatalf("chat-graph: %v", err)
		}
	}
}

// lockedListener holds <dir>/lock for as long as the listener is open.
type lockedListener struct {
	net.Listener
	lock *os.File
}

func (l *lockedListener) Close() error {
	err := l.Listener.Close()
	l.lock.Close()
	return err
}

// listen opens <dir>/sock with mode 0600. Two writers on one store is what
// this refuses: the sidecar first takes an exclusive flock on <dir>/lock,
// which the kernel drops when the process dies, so two sidecars started at
// once cannot both judge the socket stale and delete each other's. A socket
// file nobody answers on is left over from a crash and is replaced; one that
// answers belongs to a live sidecar.
func listen(dir string) (net.Listener, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("--dir must be an absolute path, got %q", dir)
	}
	lock, err := os.OpenFile(filepath.Join(dir, lockName), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("another sidecar holds %s", lock.Name())
		}
		return nil, fmt.Errorf("cannot lock %s: %v", lock.Name(), err)
	}
	ln, err := listenSocket(filepath.Join(dir, socketName))
	if err != nil {
		lock.Close()
		return nil, err
	}
	return &lockedListener{Listener: ln, lock: lock}, nil
}

func listenSocket(path string) (net.Listener, error) {
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
