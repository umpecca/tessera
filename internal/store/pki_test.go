package store

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"testing"
)

func TestPKIFiles(t *testing.T) {
	st, err := Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	files := st.PKIFiles()
	if _, err := files.ReadFile("root-ca.crt"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing file: %v", err)
	}
	for _, data := range []string{"first", "second"} {
		if err := files.WriteFile("root-ca.crt", []byte(data)); err != nil {
			t.Fatal(err)
		}
		if got, err := files.ReadFile("root-ca.crt"); err != nil || !bytes.Equal(got, []byte(data)) {
			t.Fatalf("read = %q, %v", got, err)
		}
	}
}
