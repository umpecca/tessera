// By default two fingers scroll, leaving one finger for selection, horizontal
// panning or application presses. Phone Scroll mode can start with one finger
// instead. Once a second finger lands, the gesture stays two-finger-only until
// every finger lifts, so lifting one early cannot start a selection/local drag.
export class TerminalTouchScroll {
  constructor() {
    this.touches = new Map();
    this.scrolling = false;
    this.y = null;
    this.requiredFingers = 2;
  }

  // Notes a finger down. Returns true once the requested threshold starts a
  // scroll, and for any finger that lands during one.
  down(event, minimumFingers = 2) {
    if (event.pointerType !== "touch") return false;
    if (!this.touches.size) this.requiredFingers = minimumFingers;
    this.touches.set(event.pointerId, event.clientY);
    // Once a second finger joins, never turn the remaining finger back into a
    // local scroll or selection until the whole gesture ends.
    if (this.touches.size >= 2) this.requiredFingers = 2;
    if (this.touches.size < this.requiredFingers && !this.scrolling) return false;
    this.scrolling = true;
    this.y = this.middle();
    return true;
  }

  // Returns how far the fingers moved down, in pixels, while scrolling, and
  // null for a pointer that isn't part of a scroll.
  move(event) {
    if (!this.scrolling || !this.touches.has(event.pointerId)) {
      if (this.touches.has(event.pointerId)) this.touches.set(event.pointerId, event.clientY);
      return null;
    }
    this.touches.set(event.pointerId, event.clientY);
    if (this.touches.size < this.requiredFingers) return 0;
    const y = this.middle();
    const moved = y - this.y;
    this.y = y;
    return moved;
  }

  // Notes a finger lifted or cancelled. Returns true when it was part of a
  // scroll, which the terminal shouldn't hear about.
  up(event) {
    if (!this.touches.delete(event.pointerId)) return false;
    const scrolling = this.scrolling;
    if (this.touches.size === 0) {
      this.scrolling = false;
      this.y = null;
    } else if (scrolling) {
      this.y = this.middle();
    }
    return scrolling;
  }

  middle() {
    let total = 0;
    for (const y of this.touches.values()) total += y;
    return total / this.touches.size;
  }

  reset() {
    this.touches.clear();
    this.scrolling = false;
    this.y = null;
    this.requiredFingers = 2;
  }
}
