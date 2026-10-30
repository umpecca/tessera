package store

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func TestBrowserStorageQuotaIsolationAndClear(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "site.db"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows can't remove the temporary directory while the database is open.
	defer st.Close()
	const origin = "http://localhost:8080"
	if err := st.ApplyBrowserStorage(ctx, "alice", origin, []BrowserStorageOp{
		{Op: "set", Key: "a", Value: "1"}, {Op: "set", Key: "b", Value: "2"}, {Op: "remove", Key: "a"}, {Op: "set", Key: "b", Value: "3"},
	}, 100); err != nil {
		t.Fatal(err)
	}
	if items, err := st.BrowserStorage(ctx, "alice", origin); err != nil || len(items) != 1 || items["b"] != "3" {
		t.Fatalf("items = %v, %v", items, err)
	}
	// Over quota, the whole batch is refused.
	err = st.ApplyBrowserStorage(ctx, "alice", origin, []BrowserStorageOp{{Op: "set", Key: "c", Value: "x"}, {Op: "set", Key: "big", Value: string(make([]byte, 100))}}, 100)
	if !errors.Is(err, ErrBrowserStorageQuota) {
		t.Fatalf("over quota = %v", err)
	}
	if items, _ := st.BrowserStorage(ctx, "alice", origin); len(items) != 1 {
		t.Fatalf("refused batch applied: %v", items)
	}
	for _, other := range [][2]string{{"bob", origin}, {"alice", "http://localhost:5000"}} {
		if items, _ := st.BrowserStorage(ctx, other[0], other[1]); len(items) != 0 {
			t.Fatalf("%v sees %v", other, items)
		}
	}

	cookies := []BrowserCookie{{Name: "sid", Value: "v", Path: "/", Expires: 99, HTTPOnly: true, SameSite: "Lax", Created: 1}}
	if err := st.SaveBrowserCookies(ctx, "alice", origin, cookies); err != nil {
		t.Fatal(err)
	}
	if got, err := st.BrowserCookies(ctx, "alice", origin); err != nil || len(got) != 1 || got[0] != cookies[0] {
		t.Fatalf("cookies = %+v, %v", got, err)
	}
	if err := st.ClearBrowserSiteData(ctx, "alice", origin); err != nil {
		t.Fatal(err)
	}
	items, _ := st.BrowserStorage(ctx, "alice", origin)
	got, _ := st.BrowserCookies(ctx, "alice", origin)
	if len(items) != 0 || len(got) != 0 {
		t.Fatalf("after clear: %v %v", items, got)
	}
}

func TestBrowserStorageSizeCountsUTF16(t *testing.T) {
	if got := BrowserStorageSize("ab", "é😀"); got != 5 {
		t.Fatalf("size = %d, want 5", got)
	}
}
