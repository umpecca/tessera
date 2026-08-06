package httpapi

import (
	"bufio"
	"compress/gzip"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// gzipETagSuffix marks a validator as belonging to the compressed form of a
// response. Compressed and identity bytes are different representations, so
// they cannot share an ETag; the suffix is added on the way out and taken
// off an incoming If-None-Match, which keeps revalidation working without
// the handlers underneath knowing anything about encodings.
const gzipETagSuffix = "-gzip"

// Below this, compressing costs more than it saves: gzip's own framing is
// tens of bytes, and a response this small fits in one packet either way.
const minimumCompressedSize = 512

// compressibleType reports whether a media type is worth compressing.
// Everything else — fonts, images, audio, archives — is already compressed,
// and running it through gzip only burns CPU to make it slightly larger.
func compressibleType(contentType string) bool {
	media := contentType
	if index := strings.IndexByte(media, ';'); index >= 0 {
		media = media[:index]
	}
	media = strings.ToLower(strings.TrimSpace(media))
	switch media {
	case "application/json", "application/javascript", "application/xml",
		"application/manifest+json", "application/wasm", "image/svg+xml":
		return true
	}
	// Server-sent events are a stream the client reads as it arrives, and
	// buffering them into compression blocks would hold events back.
	if media == "text/event-stream" {
		return false
	}
	return strings.HasPrefix(media, "text/")
}

func acceptsGzip(r *http.Request) bool {
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name := strings.TrimSpace(encoding)
		if index := strings.IndexByte(name, ';'); index >= 0 {
			name = name[:index]
		}
		if strings.EqualFold(name, "gzip") {
			return true
		}
	}
	return false
}

var gzipWriterPool = sync.Pool{
	New: func() any { return gzip.NewWriter(nil) },
}

// NewCompressionHandler compresses responses whose media type benefits from
// it. Streaming endpoints, hijacked connections such as the terminal
// websocket, and already-compressed payloads pass through untouched.
func NewCompressionHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) || r.Header.Get("Upgrade") != "" {
			next.ServeHTTP(w, r)
			return
		}
		writer := &compressResponseWriter{ResponseWriter: w}
		writer.restoreETag = stripGzipETagSuffix(r)
		defer writer.finish()
		next.ServeHTTP(writer, r)
	})
}

// stripGzipETagSuffix rewrites a returning client's validator into the one
// the handler underneath will recognise, and reports whether it did.
func stripGzipETagSuffix(r *http.Request) bool {
	header := r.Header.Get("If-None-Match")
	if header == "" || !strings.Contains(header, gzipETagSuffix+`"`) {
		return false
	}
	r.Header.Set("If-None-Match", strings.ReplaceAll(header, gzipETagSuffix+`"`, `"`))
	return true
}

func addGzipETagSuffix(header http.Header) {
	tag := header.Get("ETag")
	if tag == "" || strings.HasSuffix(tag, gzipETagSuffix+`"`) {
		return
	}
	if strings.HasSuffix(tag, `"`) {
		header.Set("ETag", tag[:len(tag)-1]+gzipETagSuffix+`"`)
	}
}

type compressResponseWriter struct {
	http.ResponseWriter
	gzip        *gzip.Writer
	wroteHeader bool
	compressing bool
	restoreETag bool
	hijacked    bool
}

func (w *compressResponseWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	header := w.Header()
	compressible := compressibleType(header.Get("Content-Type"))

	// The response a cache stores depends on what the client asked for, so
	// say so whether or not this particular response was compressed.
	if compressible || w.restoreETag {
		header.Add("Vary", "Accept-Encoding")
	}
	if status == http.StatusNotModified {
		// Nothing to compress, but the client's validator has to come back
		// in the form it sent.
		if w.restoreETag {
			addGzipETagSuffix(header)
		}
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if compressible && status == http.StatusOK &&
		header.Get("Content-Encoding") == "" && !belowCompressionThreshold(header) {
		w.compressing = true
		header.Del("Content-Length")
		header.Set("Content-Encoding", "gzip")
		addGzipETagSuffix(header)
		w.gzip = gzipWriterPool.Get().(*gzip.Writer)
		w.gzip.Reset(w.ResponseWriter)
	}
	w.ResponseWriter.WriteHeader(status)
}

func belowCompressionThreshold(header http.Header) bool {
	length := header.Get("Content-Length")
	if length == "" {
		return false
	}
	size, err := strconv.Atoi(length)
	return err == nil && size >= 0 && size < minimumCompressedSize
}

func (w *compressResponseWriter) Write(value []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.compressing {
		return w.gzip.Write(value)
	}
	return w.ResponseWriter.Write(value)
}

func (w *compressResponseWriter) Flush() {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	if w.compressing {
		_ = w.gzip.Flush()
	}
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Hijack hands the connection over untouched. The terminal websocket takes
// this path, and nothing about it is an HTTP response any more.
func (w *compressResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	w.hijacked = true
	w.wroteHeader = true
	return hijacker.Hijack()
}

func (w *compressResponseWriter) Push(target string, opts *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, opts)
	}
	return http.ErrNotSupported
}

func (w *compressResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// finish closes the gzip stream so its trailer reaches the client, and
// returns the writer for reuse.
func (w *compressResponseWriter) finish() {
	if w.gzip == nil {
		return
	}
	if !w.hijacked {
		_ = w.gzip.Close()
	}
	w.gzip.Reset(nil)
	gzipWriterPool.Put(w.gzip)
	w.gzip = nil
	w.compressing = false
}
