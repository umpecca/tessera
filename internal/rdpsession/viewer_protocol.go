package rdpsession

import "errors"

// The viewer protocol: the binary WebSocket messages between a kept session
// and the browser showing it. Each message is a type byte and its payload;
// integers are little-endian.
//
// Host to viewer:
//
//	ViewDesktopSize  [width u16][height u16]
//	ViewH264         [surface u16][view u8][region count u16][x, y, width, height u16 each][Annex B data]
//	                 view: 0 AVC420, 1 AVC444 main view, 2 AVC444 auxiliary view,
//	                 plus 4 for the AVC444v2 layout and 8 when the auxiliary view follows;
//	                 surface operations, with no data and values four to a region:
//	                 16 surface shown at [x, y, 0, 0] (no region: not shown),
//	                 17 copy [x, y, width, height] to [x, y, destination, 0] each,
//	                 18 every surface gone
//	ViewImage        [x u16][y u16][width u16][height u16][RGBA rows]
//	ViewEnded        [End u8][UTF-8 reason]: the session is lost or over
//	ViewDetached     [UTF-8 reason]: another viewer took over
//
// Viewer to host:
//
//	ViewInput        input records (see validInput)
//	ViewResize       [width u16][height u16], optionally [scale u16]: the
//	                 desktop scale factor in percent, 100 to 500
//	ViewRefresh      (no payload)
//	ViewWiggle       [flags u8]: 1 the window wants the mouse wiggler, 2 the
//	                 window is in use (see wiggle.go)
const (
	ViewDesktopSize = 1
	ViewH264        = 2
	ViewImage       = 3
	ViewEnded       = 4
	ViewDetached    = 5

	ViewInput   = 1
	ViewResize  = 2
	ViewRefresh = 3
	ViewWiggle  = 4
)

// Bounds on a resize request: RDP allows 200 to 8192 pixels each way.
const (
	minDesktopSide = 200
	maxDesktopSide = 8192
)

// ErrViewerMessage means a viewer sent a message the protocol doesn't allow.
var ErrViewerMessage = errors.New("invalid RDP viewer message")

// ViewFrame turns a module event into the message for the viewer, and
// reports false for events viewers don't get.
func ViewFrame(kind uint32, payload []byte) ([]byte, bool) {
	var viewType byte
	switch kind {
	case eventConnected, eventDesktopSize:
		if len(payload) < 4 {
			return nil, false
		}
		return append([]byte{ViewDesktopSize}, payload[:4]...), true
	case eventH264:
		viewType = ViewH264
	case eventImage:
		viewType = ViewImage
	case eventEnded:
		viewType = ViewEnded
	default:
		return nil, false
	}
	return append([]byte{viewType}, payload...), true
}

// DetachedFrame is the message telling a viewer another viewer took over.
func DetachedFrame(reason string) []byte {
	return append([]byte{ViewDetached}, reason...)
}

// EndsView reports whether a frame ends the viewer's connection: the session
// is lost or over, or another viewer took it.
func EndsView(frame []byte) bool {
	return len(frame) > 0 && (frame[0] == ViewEnded || frame[0] == ViewDetached)
}
