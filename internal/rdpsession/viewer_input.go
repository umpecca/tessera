package rdpsession

import "encoding/binary"

// HandleViewerMessage applies a message from the session's viewer. Input that
// doesn't reach an active session is dropped, as a disconnected keyboard's
// would be. A message the protocol doesn't allow is ErrViewerMessage, after
// which the viewer should be disconnected.
func (s *Session) HandleViewerMessage(message []byte) error {
	if len(message) == 0 {
		return ErrViewerMessage
	}
	payload := message[1:]
	switch message[0] {
	case ViewInput:
		// The module reads at most recvCapacity bytes per message.
		if len(payload)+1 > recvCapacity || !validInput(payload) {
			return ErrViewerMessage
		}
		s.Post(append([]byte{tagInput}, payload...))
	case ViewResize:
		if len(payload) != 4 && len(payload) != 6 {
			return ErrViewerMessage
		}
		width := int(binary.LittleEndian.Uint16(payload))
		height := int(binary.LittleEndian.Uint16(payload[2:]))
		if width < minDesktopSide || width > maxDesktopSide || height < minDesktopSide || height > maxDesktopSide {
			return ErrViewerMessage
		}
		if len(payload) == 6 {
			scale := int(binary.LittleEndian.Uint16(payload[4:]))
			if !validScale(scale) {
				return ErrViewerMessage
			}
			s.requestScaledLayout(Layout{Width: width, Height: height, Scale: scale}, scaledLayoutWatch)
			return nil
		}
		s.Post(append([]byte{tagResize}, payload...))
	case ViewRefresh:
		if len(payload) != 0 {
			return ErrViewerMessage
		}
		s.Post([]byte{tagRefresh})
	default:
		return ErrViewerMessage
	}
	return nil
}
