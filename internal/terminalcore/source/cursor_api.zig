
// Tessera DECSCUSR (CSI Ps SP q). Ghostty keeps the cursor's shape on the
// screen and its blink in mode 12, which snapshots carry, but the pinned API
// had no way to read them, and it treats CSI 0 SP q (the terminal's default)
// as a steady block. The handler records whether the last DECSCUSR was 0, or
// none came since a reset, so the browser can use the pane's own cursor then.
// Mode 12 on its own does not count: terminfo's cnorm for xterm sends
// CSI ? 12 l, so every ncurses program that exits would stop the blink.

/// 0 while the pane's own cursor applies. Otherwise 8 (set by a program),
/// plus the shape (0 block, 1 bar, 2 underline), plus 4 when it blinks.
pub fn cursor_style(ptr: ?*anyopaque) callconv(.c) u32 {
    const w: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return 0));
    if (w.stream.handler.cursor_default) return 0;
    const shape: u32 = switch (w.terminal.screens.active.cursor.cursor_style) {
        .block, .block_hollow => 0,
        .bar => 1,
        .underline => 2,
    };
    return 8 | shape | (if (w.terminal.modes.get(.cursor_blinking)) @as(u32, 4) else 0);
}
