package main

import (
	_ "embed"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed index.html
var page []byte

func main() {
	addr := os.Args[1]
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(page)
	})
	// Echo every binary message immediately, standing in for PTY echo.
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			kind, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage {
				if conn.WriteMessage(websocket.BinaryMessage, data) != nil {
					return
				}
			}
		}
	})
	http.HandleFunc("/results", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		name := fmt.Sprintf("results-%s.json", time.Now().Format("150405"))
		os.WriteFile(name, body, 0o644)
		log.Printf("saved %s (%d bytes) from %s", name, len(body), r.UserAgent())
	})
	log.Fatal(http.ListenAndServe(addr, nil))
}
