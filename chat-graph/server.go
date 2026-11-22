package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"

	"codeman/chat-graph/store"
)

const maxBodyBytes = 1 << 20

var errorCodes = []struct {
	err    error
	status int
	code   string
}{
	{store.ErrInvalid, http.StatusBadRequest, "invalid"},
	{store.ErrNotFound, http.StatusNotFound, "not_found"},
	{store.ErrConflict, http.StatusConflict, "conflict"},
}

// newHandler serves the store's routes. GET /health answers with this
// process's pid, which is how Codeman tells its own child's answer from
// another sidecar's on the socket.
// dl, when not nil, is given every newly stored message and told when one is
// routed.
func newHandler(st *store.Store, dl *deadlines) http.Handler {
	health := []byte(fmt.Sprintf(`{"ok":true,"pid":%d}`, os.Getpid()))
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(health)
	})
	mux.HandleFunc("POST /messages", func(w http.ResponseWriter, r *http.Request) {
		m, err := parseBody(w, r, store.ParseMessage)
		if err == nil {
			err = st.AddMessage(m)
		}
		if err == nil {
			if routed, rerr := st.Routed(m.ID); rerr == nil && !routed {
				dl.add(m.ID)
			}
		}
		respond(w, m, err)
	})
	mux.HandleFunc("POST /ops", func(w http.ResponseWriter, r *http.Request) {
		op, err := parseBody(w, r, store.ParseOp)
		var res store.OpResult
		if err == nil {
			res, err = st.Apply(op)
		}
		respond(w, res, err)
	})
	mux.HandleFunc("POST /ops/{id}/undo", func(w http.ResponseWriter, r *http.Request) {
		res, err := st.Undo(r.PathValue("id"))
		respond(w, res, err)
	})
	mux.HandleFunc("GET /topics", func(w http.ResponseWriter, _ *http.Request) {
		topics, err := st.Topics()
		respond(w, topics, err)
	})
	mux.HandleFunc("GET /topics/{id}", func(w http.ResponseWriter, r *http.Request) {
		topic, err := st.Topic(r.PathValue("id"))
		respond(w, topic, err)
	})
	registerRouting(mux, st, dl)
	return mux
}

func parseBody[T any](w http.ResponseWriter, r *http.Request, parse func([]byte) (T, error)) (T, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		var zero T
		return zero, fmt.Errorf("%w: body unreadable or over %d bytes", store.ErrInvalid, maxBodyBytes)
	}
	return parse(raw)
}

func respond(w http.ResponseWriter, body any, err error) {
	status := http.StatusOK
	if err != nil {
		status = http.StatusInternalServerError
		code := "internal"
		for _, e := range errorCodes {
			if errors.Is(err, e.err) {
				status, code = e.status, e.code
				break
			}
		}
		msg := err.Error()
		if status == http.StatusInternalServerError {
			log.Printf("chat-graph: %v", err)
			msg = "internal error"
		}
		body = map[string]string{"error": msg, "code": code}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
