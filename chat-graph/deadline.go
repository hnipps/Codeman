package main

import (
	"context"
	"log"
	"sync"
	"time"

	"codeman/chat-graph/store"
)

// routeDeadline is how long a stored message may wait for Codeman's route
// before the sidecar files it to Unsorted itself (invariant I2).
const routeDeadline = 20 * time.Second

// deadlines holds every stored message that has no route yet, with the time
// it is due. It lives in memory: a restart seeds it from the store, which
// gives every message still waiting a fresh deadline.
type deadlines struct {
	mu    sync.Mutex
	due   map[string]time.Time
	after time.Duration
	now   func() time.Time
}

func newDeadlines(after time.Duration, now func() time.Time) *deadlines {
	return &deadlines{due: map[string]time.Time{}, after: after, now: now}
}

// add starts id's deadline unless one is already running. A nil receiver
// does nothing, so tests that need no deadline pass nil.
func (d *deadlines) add(id string) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.due[id]; !ok {
		d.due[id] = d.now().Add(d.after)
	}
}

func (d *deadlines) done(id string) {
	if d == nil {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.due, id)
}

func (d *deadlines) expired() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	var out []string
	for id, at := range d.due {
		if !now.Before(at) {
			out = append(out, id)
		}
	}
	return out
}

// seed starts a deadline for every message the store holds without a route.
func (d *deadlines) seed(st *store.Store) error {
	ids, err := st.UnroutedMessages()
	if err != nil {
		return err
	}
	for _, id := range ids {
		d.add(id)
	}
	return nil
}

// sweep files every message past its deadline to Unsorted. A route that
// arrived in the meantime wins: routeMessage answers with the stored one.
func (d *deadlines) sweep(st *store.Store) {
	for _, id := range d.expired() {
		if _, err := routeMessage(st, id, routeBody{Unsorted: true}); err != nil {
			// Try again after another deadline rather than leaving it unrouted until a restart.
			log.Printf("chat-graph: filing %s to Unsorted: %v", id, err)
			d.done(id)
			d.add(id)
			continue
		}
		d.done(id)
	}
}

func (d *deadlines) run(ctx context.Context, st *store.Store, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.sweep(st)
		}
	}
}
