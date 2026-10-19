import fs from "node:fs/promises";
import path from "node:path";

// Applied only to the pinned source checkout, after ghostty-web's WASM patch.
const root = path.resolve(process.argv[2] || ".cache/sixel/ghostty-web/ghostty");
const awaitExtension = await fs.readFile("internal/terminalcore/source/sixel_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/snapshot_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/audio_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/file_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/hyperlink_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/pwd_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/pointer_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/semantic_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/color_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/attention_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/report_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/query_api.zig", "utf8");
async function edit(file, transform) {
  const target = path.join(root, file);
  const source = await fs.readFile(target, "utf8");
  await fs.writeFile(target, transform(source.replaceAll("\r\n", "\n")));
}
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Pinned Ghostty source changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
for (const name of ["sixel.zig", "sixel_store.zig", "snapshot.zig", "audio.zig", "file.zig"]) {
  await fs.copyFile(`internal/terminalcore/source/${name}`, path.join(root, "src/terminal/c", name));
}
await edit("src/terminal/page.zig", (source) => {
  if (source.includes("sixel: u18")) return source;
  source = replace(source, "_padding: u18 = 0,", "sixel: u18 = 0,");
  source = replace(source, "pub fn isEmpty(self: Cell) bool {", "pub fn isEmpty(self: Cell) bool {\n        if (self.sixel != 0) return false;");
  source = replace(source, "if (cell.hasText()) return true;", "if (cell.hasText() or cell.sixel != 0) return true;");
  return source;
});
await edit("src/terminal/page.zig", (source) => {
  if (source.includes("sixel_present: bool")) return source;
  source = replace(source, "    dirty: bool,", `    dirty: bool,

    // Conservative Sixel membership, independent of renderer dirty flags.
    // Collection clears this after checking a page; copies may set it early.
    sixel_present: bool = false,`);
  source = replace(source, "        // This whole operation breaks integrity until the end.", "        self.sixel_present = self.sixel_present or other.sixel_present;\n\n        // This whole operation breaks integrity until the end.");
  return source;
});
await edit("src/terminal/page.zig", (source) => source.includes("// Tessera row image membership") ? source : replace(source,
  "    _padding: u22 = 0,",
  "    // Tessera row image membership; rebuilt by collection after mutations.\n    sixel_present: bool = false,\n    _padding: u21 = 0,"));
await edit("src/terminal/PageList.zig", (source) => {
  const marker = "    fn copyRowMetadata(self: *ReflowCursor, other: *const Row) void {";
  if (source.includes("// Reflow may move Sixel cells")) return source;
  return replace(source, marker, marker + `
        // Reflow may move Sixel cells to any destination page. Check these
        // pages once after resizing; ordinary copies carry page membership.
        self.page.sixel_present = true;`);
});
await edit("src/terminal/PageList.zig", (source) => {
  if (source.includes("// Tessera: initialize recycled initial page buffers.")) return source;
  source = replace(source, `        // In runtime safety modes we have to memset because the Zig allocator
        // interface will always memset to 0xAA for undefined. In non-safe modes
        // we use a page allocator and the OS guarantees zeroed memory.
        if (comptime std.debug.runtime_safety) @memset(page_buf, 0);`,
    `        // Tessera: initialize recycled initial page buffers.
        // WASM's page allocator reuses freed heap memory, including allocations
        // from closed terminals. initBuf initializes row offsets, not cells.
        @memset(page_buf, 0);`);
  const before = source.includes("// Tessera: grown pages may reuse dirty WASM allocation bytes.")
    ? `    // Tessera: grown pages may reuse dirty WASM allocation bytes.
    // Pooled pages are cleared on return; unpooled pages need blank cells
    // before initBuf and cloning, including cells beyond the copied rows.
    if (!pooled or std.debug.runtime_safety) @memset(page_buf, 0);`
    : `    // Required only with runtime safety because allocators initialize
    // to undefined, 0xAA.
    if (comptime std.debug.runtime_safety) @memset(page_buf, 0);`;
  return replace(source, before,
    `    // Tessera: initialize every growing page, including fresh pool items.
    // Pool return clears used page memory, but newly allocated items and any
    // capacity beyond a former layout may still contain recycled heap bytes.
    @memset(page_buf, 0);`);
});
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("// Tessera Sixel API")) return source.slice(0, source.indexOf("// Tessera Sixel API")) + awaitExtension;
  source = replace(source, 'const log = std.log.scoped(.terminal_c);', 'const log = std.log.scoped(.terminal_c);\nconst SixelStore = @import("sixel_store.zig").Store;');
  source = replace(source, "response_buffer: *std.ArrayList(u8),", "response_buffer: *std.ArrayList(u8),\n    sixel: *SixelStore,");
  source = replace(source, "response_buffer: *std.ArrayList(u8)) ResponseHandler", "response_buffer: *std.ArrayList(u8), sixel: *SixelStore) ResponseHandler");
  source = replace(source, ".response_buffer = response_buffer,", ".response_buffer = response_buffer,\n            .sixel = sixel,");
  source = replace(source, "    pub fn vt(", "    pub fn cancelDcs(self: *ResponseHandler) void { self.sixel.active = false; self.sixel.decoder.deinit(self.alloc); }\n\n    pub fn vt(");
  source = replace(source, "            .dcs_hook,\n            .dcs_put,\n            .dcs_unhook,", "            .dcs_hook => self.sixel.begin(self.alloc, self.terminal, value),\n            .dcs_put => self.sixel.put(self.alloc, value),\n            .dcs_unhook => try self.sixel.end(self.alloc, self.terminal),");
  source = replace(source, "            .device_attributes,\n", "");
  source = replace(source, "            // Actions that require no response", '            .device_attributes => if (value == .primary) { try self.response_buffer.appendSlice(self.alloc, "\\x1b[?62;4c"); },\n\n            // Actions that require no response');
  source = replace(source, ".full_reset => self.terminal.fullReset(),", ".full_reset => { self.sixel.deinit(self.alloc); self.terminal.fullReset(); },");
  source = replace(source, "    response_buffer: std.ArrayList(u8),", "    response_buffer: std.ArrayList(u8),\n    sixel: SixelStore = .{},");
  source = replace(source, "wrapper.handler = ResponseHandler.init(alloc, &wrapper.terminal, &wrapper.response_buffer);", "wrapper.sixel = .{};\n    wrapper.handler = ResponseHandler.init(alloc, &wrapper.terminal, &wrapper.response_buffer, &wrapper.sixel);");
  source = replace(source, "    wrapper.stream.deinit();", "    wrapper.sixel.deinit(alloc);\n    wrapper.stream.deinit();");
  source = replace(source, "    wrapper.stream.nextSlice(data[0..len]) catch return;", "    wrapper.stream.nextSlice(data[0..len]) catch return;\n    wrapper.sixel.collect(wrapper.alloc, &wrapper.terminal) catch {}; ");
  return source + awaitExtension;
});
await edit("src/terminal/c/terminal.zig", (source) => {
  if (!source.includes("// Tessera resize invalidates image membership")) source = replace(source,
    "    wrapper.terminal.resize(wrapper.alloc, @intCast(cols), @intCast(rows)) catch return;",
    "    wrapper.terminal.resize(wrapper.alloc, @intCast(cols), @intCast(rows)) catch return;\n    // Tessera resize invalidates image membership, including reflow copies.\n    wrapper.sixel.collection_pending = true;\n    wrapper.sixel.collect(wrapper.alloc, &wrapper.terminal) catch {};");
  return source;
});
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("fn renderStateReadRows(")) return source;
  const start = source.indexOf("pub fn renderStateGetViewport(");
  const end = source.indexOf("/// Get grapheme codepoints", start);
  if (start < 0 || end < 0) throw new Error("Pinned viewport reader changed");
  let reader = source.slice(start, end);
  reader = replace(reader, "pub fn renderStateGetViewport(", "fn renderStateReadRows(");
  reader = replace(reader, "    ptr: ?*anyopaque,", "    ptr: ?*anyopaque,\n    first: usize,\n    count: usize,");
  reader = replace(reader, "    const rows = rs.rows;", "    if (first > rs.rows or count > rs.rows - first) return -1;\n    const rows = count;");
  reader = replace(reader, "    for (0..rows) |y| {", "    for (first..first + rows) |y| {");
  return source.slice(0, start) + `pub fn renderStateGetViewport(ptr: ?*anyopaque, out: [*]GhosttyCell, capacity: usize) callconv(.c) c_int {
    const wrapper: *const TerminalWrapper = @ptrCast(@alignCast(ptr orelse return -1));
    return renderStateReadRows(ptr, 0, wrapper.render_state.rows, out, capacity);
}

` + reader + source.slice(end);
});

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("snapshot_data: []u8")) return source;
  source = replace(source, "    sixel: SixelStore = .{},", "    sixel: SixelStore = .{},\n    snapshot_data: []u8 = &.{},");
  source = replace(source, "    wrapper.sixel.deinit(alloc);", "    alloc.free(wrapper.snapshot_data);\n    wrapper.sixel.deinit(alloc);");
  source = replace(source, "    sixel: *SixelStore,", "    sixel: *SixelStore,\n    osc_raw: std.ArrayList(u8) = .{},");
  source = replace(source, "        _ = self;\n    }\n\n    pub fn cancelDcs", "        self.osc_raw.deinit(self.alloc);\n    }\n\n    pub fn cancelDcs");
  source = replace(source, "    pub fn cancelDcs", `    pub fn observeControl(self: *ResponseHandler, state: anytype, ch: u8) !void {
        if (state == .escape and ch == ']') {
            self.osc_raw.clearRetainingCapacity();
            try self.osc_raw.appendSlice(self.alloc, "\\x1b]");
        } else if (state == .osc_string) {
            if (ch == 7 or ch == 0x1b or ch == 0x18 or ch == 0x1a) {
                self.osc_raw.clearRetainingCapacity();
            } else if (self.osc_raw.items.len < 1024 * 1024 + 32) {
                try self.osc_raw.append(self.alloc, ch);
            }
        }
    }
    pub fn cancelDcs`);
  return source;
});
await edit("src/terminal/PageList.zig", (source) => source.replace(/^inline fn createPage\(/m, "pub inline fn createPage(").replace(/^fn destroyNode\(self:/m, "pub fn destroyNode(self:"));
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("clipboard: std.ArrayList")) return source;
  source = replace(source, "    osc_raw: std.ArrayList(u8) = .{},", "    osc_raw: std.ArrayList(u8) = .{},\n    clipboard: std.ArrayList(u8) = .{},");
  source = replace(source, "        self.osc_raw.deinit(self.alloc);", "        self.osc_raw.deinit(self.alloc);\n        self.clipboard.deinit(self.alloc);");
  source = replace(source, "wrapper.stream = ResponseStream.init(wrapper.handler);", "wrapper.stream = ResponseStream.initAlloc(alloc, wrapper.handler);");
  source = replace(source, "            .clipboard_contents,\n", "");
  source = replace(source, "            .size_report,\n", "");
  source = replace(source, "            // Actions that require no response", `            .clipboard_contents => {
                if (value.data.len > 0 and value.data.len <= 1024 * 1024 and !std.mem.eql(u8, value.data, "?")) {
                    var length: [4]u8 = undefined;
                    std.mem.writeInt(u32, &length, @intCast(value.data.len), .little);
                    try self.clipboard.appendSlice(self.alloc, &length);
                    try self.clipboard.appendSlice(self.alloc, value.data);
                }
            },
            .size_report => {
                var buffer: [64]u8 = undefined;
                const text = switch (value) {
                    .csi_14_t => try std.fmt.bufPrint(&buffer, "\\x1b[4;{d};{d}t", .{ self.terminal.height_px, self.terminal.width_px }),
                    .csi_16_t => try std.fmt.bufPrint(&buffer, "\\x1b[6;{d};{d}t", .{ self.sixel.cell_height, self.sixel.cell_width }),
                    .csi_18_t => try std.fmt.bufPrint(&buffer, "\\x1b[8;{d};{d}t", .{ self.terminal.rows, self.terminal.cols }),
                    else => "",
                };
                try self.response_buffer.appendSlice(self.alloc, text);
            },
            // Actions that require no response`);
  source = replace(source, "    pub fn cancelDcs", `    pub fn graphicsQuery(self: *ResponseHandler, input: anytype) !bool {
        if (input.final != 'S' or input.intermediates.len != 1 or input.intermediates[0] != '?') return false;
        if (input.params.len < 2) return true;
        const item = input.params[0];
        const action = input.params[1];
        var buf: [96]u8 = undefined;
        const result = if (item == 1 and (action == 1 or action == 2 or action == 4)) blk: {
            if (action == 2) self.sixel.palette = @import("sixel.zig").defaultPalette();
            break :blk try std.fmt.bufPrint(&buf, "\\x1b[?1;0;256S", .{});
        } else if (item == 2 and (action == 1 or action == 4))
            try std.fmt.bufPrint(&buf, "\\x1b[?2;0;{d};{d}S", .{ self.terminal.width_px, self.terminal.height_px })
        else try std.fmt.bufPrint(&buf, "\\x1b[?{d};1S", .{item});
        try self.response_buffer.appendSlice(self.alloc, result);
        return true;
    }
    pub fn cancelDcs`);
  source = replace(source, "        switch (mode) {", "        if (mode == .sixel_display) self.sixel.scrolling = !enabled;\n        switch (mode) {");
  return source;
});
await edit("src/terminal/modes.zig", (source) => source.includes('name = "sixel_display"') ? source : replace(source, "    // ANSI", '    .{ .name = "sixel_display", .value = 80 },\n    // ANSI'));
await edit("src/terminal/osc.zig", (source) => source.includes("list.items.len >= 1024 * 1024") ? source : replace(source, "                const list = self.buf_dynamic.?;", "                const list = self.buf_dynamic.?;\n                if (list.items.len >= 1024 * 1024) { self.state = .invalid; self.complete = false; return; }"));

await edit("src/terminal/stream.zig", (source) => {
  if (source.includes('"cancelDcs"')) return source;
  const marker = "fn nextNonUtf8(self: *Self, c: u8) !void {";
  return replace(source, marker, marker + '\n            if ((c == 0x18 or c == 0x1a) and @hasDecl(Handler, "cancelDcs")) self.handler.cancelDcs();');
});
await edit("src/terminal/stream.zig", (source) => {
  if (source.includes('"graphicsQuery"')) return source;
  const marker = "inline fn csiDispatch(self: *Self, input: Parser.Action.CSI) !void {";
  return replace(source, marker, marker + '\n            if (@hasDecl(Handler, "graphicsQuery")) { if (try self.handler.graphicsQuery(input)) return; }');
});
await edit("src/terminal/stream.zig", (source) => {
  if (source.includes('"observeControl"')) return source;
  const marker = "fn nextNonUtf8(self: *Self, c: u8) !void {";
  return replace(source, marker, marker + '\n            if (@hasDecl(Handler, "observeControl")) try self.handler.observeControl(self.parser.state, c);');
});
await edit("src/terminal/c/terminal.zig", (source) => {
  // Both cell readers, viewport and scrollback, give every link the same id.
  const before = ".hyperlink_id = if (cell.hyperlink) 1 else 0,";
  const after = ".hyperlink_id = tesseraHyperlinkId(&page, cell),";
  if (source.split(after).length - 1 === 2) return source;
  if (source.split(before).length - 1 !== 2) throw new Error("Pinned hyperlink cell ids changed");
  return source.replaceAll(before, after);
});
await edit("src/lib_vt.zig", (source) => {
  const marker = '@export(&c.terminal_write, .{ .name = "ghostty_terminal_write" });';
  source = source.replace(/^\s*@export\(&c\.terminal\.sixel_[^\n]+\n/gm, "");
  const exports = ["version", "configure", "geometry", "image_count", "image_info", "image_pixels", "image_settings", "image_settings_read", "clear_images", "tiles", "viewport_row", "snapshot_export", "snapshot_release", "snapshot_data", "snapshot_import", "clipboard_read", "title_revision", "title_length", "title_data"];
  source = source.replace(/^\s*@export\(&c\.terminal\.(audio_read|file_read|hyperlink_uri|pwd_[a-z]+|mouse_shape|semantic_rows|color_revision|dynamic_colors|focus|bell_count|notification_read|set_version|progress_revision|progress|kitty_keyboard_flags|set_term_name)[^\n]+\n/gm, "");
  return replace(source, marker, marker + "\n" + exports.map((name) => `        @export(&c.terminal.sixel_${name}, .{ .name = "tessera_sixel_${name}" });`).join("\n") + '\n        @export(&c.terminal.audio_read, .{ .name = "tessera_audio_read" });\n        @export(&c.terminal.file_read, .{ .name = "tessera_file_read" });\n        @export(&c.terminal.hyperlink_uri, .{ .name = "tessera_hyperlink_uri" });' + ["revision", "length", "data"].map((name) => `\n        @export(&c.terminal.pwd_${name}, .{ .name = "tessera_pwd_${name}" });`).join("") + '\n        @export(&c.terminal.mouse_shape, .{ .name = "tessera_mouse_shape" });\n        @export(&c.terminal.semantic_rows, .{ .name = "tessera_semantic_rows" });\n        @export(&c.terminal.color_revision, .{ .name = "tessera_color_revision" });\n        @export(&c.terminal.dynamic_colors, .{ .name = "tessera_dynamic_colors" });\n        @export(&c.terminal.focus, .{ .name = "tessera_focus" });\n        @export(&c.terminal.bell_count, .{ .name = "tessera_bell_count" });\n        @export(&c.terminal.notification_read, .{ .name = "tessera_notification_read" });\n        @export(&c.terminal.set_version, .{ .name = "tessera_set_version" });\n        @export(&c.terminal.progress_revision, .{ .name = "tessera_progress_revision" });\n        @export(&c.terminal.progress, .{ .name = "tessera_progress" });\n        @export(&c.terminal.kitty_keyboard_flags, .{ .name = "tessera_kitty_keyboard_flags" });\n        @export(&c.terminal.set_term_name, .{ .name = "tessera_set_term_name" });');
});
for (const file of ["props_uucode.zig", "symbols_uucode.zig"]) {
  await edit(`src/unicode/${file}`, (source) => source.replace("try stdout.end();", "try stdout.interface.flush();"));
}

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("audio: @import")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", '    clipboard: std.ArrayList(u8) = .{},\n    audio: @import("audio.zig").Effects = .{},\n    files: @import("file.zig").Effects = .{},');
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        self.audio.deinit(self.alloc);\n        self.files.deinit(self.alloc);");
  const start = source.indexOf("    pub fn observeControl(self: *ResponseHandler,");
  const end = source.indexOf("    pub fn graphicsQuery", start);
  if (start < 0 || end < 0) throw new Error("Pinned OSC observer changed");
  source = source.slice(0, start) + `    pub fn observeControl(self: *ResponseHandler, state: anytype, ch: u8) !void {
        const prefix = @import("audio.zig").prefix;
        const file_prefix = @import("file.zig").prefix;
        if (state == .escape) {
            // An OSC audio request is complete only after the full ST. CAN,
            // SUB, and unrelated escape sequences must not trigger playback.
            if (ch == '\\\\' and std.mem.startsWith(u8, self.osc_raw.items, prefix)) {
                try self.audio.request(self.alloc, self.osc_raw.items[prefix.len..]);
            }
            if (ch == '\\\\' and std.mem.startsWith(u8, self.osc_raw.items, file_prefix)) {
                try self.files.request(self.alloc, self.osc_raw.items[file_prefix.len..]);
            }
            self.osc_raw.clearRetainingCapacity();
            if (ch == ']') try self.osc_raw.appendSlice(self.alloc, "\\x1b]");
        } else if (state == .osc_string) {
            if (ch == 7) {
                if (std.mem.startsWith(u8, self.osc_raw.items, prefix)) {
                    try self.audio.request(self.alloc, self.osc_raw.items[prefix.len..]);
                }
                if (std.mem.startsWith(u8, self.osc_raw.items, file_prefix)) {
                    try self.files.request(self.alloc, self.osc_raw.items[file_prefix.len..]);
                }
                self.osc_raw.clearRetainingCapacity();
            } else if (ch == 0x18 or ch == 0x1a) {
                self.osc_raw.clearRetainingCapacity();
            } else if (ch == 0x1b) {
                if (!std.mem.startsWith(u8, self.osc_raw.items, prefix) and !std.mem.startsWith(u8, self.osc_raw.items, file_prefix)) self.osc_raw.clearRetainingCapacity();
            } else if (self.osc_raw.items.len < 1024 * 1024 + 32) {
                try self.osc_raw.append(self.alloc, ch);
            }
        }
    }
` + source.slice(end);
  return source;
});

await edit("src/terminal/c/terminal.zig", (source) => source.replace(
  /\.full_reset => \{[^\n]*self\.terminal\.fullReset\(\); \},/,
  '.full_reset => { const cw = self.sixel.cell_width; const ch = self.sixel.cell_height; const limit = self.sixel.memory_limit; const placeholders = self.sixel.show_placeholders; self.sixel.deinit(self.alloc); self.sixel.cell_width = cw; self.sixel.cell_height = ch; self.sixel.memory_limit = limit; self.sixel.show_placeholders = placeholders; self.osc_raw.clearRetainingCapacity(); self.audio.deinit(self.alloc); try self.audio.push(self.alloc, "reset"); self.files.deinit(self.alloc); try self.files.push(self.alloc, "reset"); self.title.clearRetainingCapacity(); self.title_revision +%= 1; self.terminal.fullReset(); self.terminal.mouse_shape = .text; self.terminal.colors.palette.resetAll(); self.terminal.colors.foreground.override = null; self.terminal.colors.background.override = null; self.terminal.colors.cursor.override = null; self.highlight_background = 0; self.highlight_foreground = 0; self.terminal.flags.dirty.palette = true; self.color_revision +%= 1; },'
));

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("title_revision: u32")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", "    clipboard: std.ArrayList(u8) = .{},\n    title: std.ArrayList(u8) = .{},\n    title_revision: u32 = 0,");
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        self.title.deinit(self.alloc);");
  source = replace(source, "            .window_title,\n", "");
  source = replace(source, "            // Actions that require no response", `            .window_title => {
                // Empty/oversized requests leave the existing pane name intact.
                if (value.title.len > 0 and value.title.len <= 4096) {
                    try self.title.ensureTotalCapacity(self.alloc, value.title.len);
                    self.title.clearRetainingCapacity();
                    self.title.appendSliceAssumeCapacity(value.title);
                    self.title_revision +%= 1;
                }
            },
            // Actions that require no response`);
  return source;
});

// OSC 133;B lands on the prompt's own row for a one-line prompt, and marking
// it as input erased where that prompt began: a prompt after a command with
// no output became indistinguishable from the one before it. Keep the mark.
await edit("src/terminal/c/terminal.zig", (source) => replace(source,
  "            .prompt_end => self.terminal.markSemanticPrompt(.input),",
  "            .prompt_end => if (self.terminal.screens.active.cursor.page_row.semantic_prompt != .prompt) self.terminal.markSemanticPrompt(.input),"));

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("color_revision: u32")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", "    clipboard: std.ArrayList(u8) = .{},\n    highlight_background: u32 = 0,\n    highlight_foreground: u32 = 0,\n    color_revision: u32 = 0,");
  source = replace(source, "            .color_operation => try self.colorOperation(value.op, &value.requests),", "            .color_operation => try self.colorOperation(value.op, &value.requests, value.terminator),");
  const start = source.indexOf("    fn colorOperation(self: *ResponseHandler, op: anytype, requests: anytype) !void {");
  const end = source.indexOf("    fn kittyColorOperation", start);
  if (start < 0 || end < 0) throw new Error("Pinned colour operation stub changed");
  return source.slice(0, start) + `    fn colorOperation(self: *ResponseHandler, op: anytype, requests: anytype, terminator: anytype) !void {
        _ = op;
        const colors = &self.terminal.colors;
        var it = requests.constIterator(0);
        while (it.next()) |req| {
            switch (req.*) {
                .query => |target| {
                    try self.reportColor(target, terminator);
                    continue;
                },
                .set => |set| switch (set.target) {
                    .palette => |i| colors.palette.set(i, set.color),
                    .dynamic => |d| switch (d) {
                        .foreground => colors.foreground.set(set.color),
                        .background => colors.background.set(set.color),
                        .cursor => colors.cursor.set(set.color),
                        .highlight_background => self.highlight_background = tesseraPackRGB(set.color),
                        .highlight_foreground => self.highlight_foreground = tesseraPackRGB(set.color),
                        else => continue,
                    },
                    .special => continue,
                },
                // Back to the pane's own colour, which follows its light or
                // dark setting (Ghostty's reset() pins the current default).
                .reset => |target| switch (target) {
                    .palette => |i| colors.palette.reset(i),
                    .dynamic => |d| switch (d) {
                        .foreground => colors.foreground.override = null,
                        .background => colors.background.override = null,
                        .cursor => colors.cursor.override = null,
                        .highlight_background => self.highlight_background = 0,
                        .highlight_foreground => self.highlight_foreground = 0,
                        else => continue,
                    },
                    .special => continue,
                },
                .reset_palette => colors.palette.resetAll(),
                .reset_special => continue,
            }
            self.terminal.flags.dirty.palette = true;
            self.color_revision +%= 1;
        }
    }

    // Answers a query as xterm does, in 16-bit rgb: form with the request's
    // terminator. The selection colours a program has not set are the ones
    // Tessera selects with: foreground and background swapped.
    fn reportColor(self: *ResponseHandler, target: anytype, terminator: anytype) !void {
        const colors = &self.terminal.colors;
        const fg = colors.foreground.get() orelse color.RGB{ .r = 204, .g = 204, .b = 204 };
        const bg = colors.background.get() orelse color.RGB{ .r = 0, .g = 0, .b = 0 };
        var buf: [64]u8 = undefined;
        const text = switch (target) {
            .palette => |i| blk: {
                const rgb = colors.palette.current[i];
                break :blk try std.fmt.bufPrint(&buf, "\\x1b]4;{d};rgb:{x:0>4}/{x:0>4}/{x:0>4}{s}", .{ i, @as(u16, rgb.r) * 257, @as(u16, rgb.g) * 257, @as(u16, rgb.b) * 257, terminator.string() });
            },
            .dynamic => |d| blk: {
                const rgb: color.RGB = switch (d) {
                    .foreground => fg,
                    .background => bg,
                    .cursor => colors.cursor.get() orelse fg,
                    .highlight_background => tesseraUnpackRGB(self.highlight_background) orelse fg,
                    .highlight_foreground => tesseraUnpackRGB(self.highlight_foreground) orelse bg,
                    else => return,
                };
                break :blk try std.fmt.bufPrint(&buf, "\\x1b]{d};rgb:{x:0>4}/{x:0>4}/{x:0>4}{s}", .{ @intFromEnum(d), @as(u16, rgb.r) * 257, @as(u16, rgb.g) * 257, @as(u16, rgb.b) * 257, terminator.string() });
            },
            .special => return,
        };
        try self.response_buffer.appendSlice(self.alloc, text);
    }

` + source.slice(end);
});

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("pwd_revision: u32")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", "    clipboard: std.ArrayList(u8) = .{},\n    pwd: std.ArrayList(u8) = .{},\n    pwd_revision: u32 = 0,");
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        self.pwd.deinit(self.alloc);");
  source = replace(source, "            .report_pwd,\n", "");
  source = replace(source, "            // Actions that require no response", `            .report_pwd => {
                // OSC 7: the shell's working directory as a file:// URL. An
                // empty or oversized report leaves the last one in place.
                if (value.url.len > 0 and value.url.len <= 8192) {
                    try self.pwd.ensureTotalCapacity(self.alloc, value.url.len);
                    self.pwd.clearRetainingCapacity();
                    self.pwd.appendSliceAssumeCapacity(value.url);
                    self.pwd_revision +%= 1;
                }
            },
            // Actions that require no response`);
  return source;
});

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("// Tessera line limit")) return source;
  source = replace(source, ".max_scrollback = scrollback_limit,", ".max_scrollback = 64 * 1024 * 1024, // Tessera line limit is enforced below");
  // Keep the public wrapper's line-based configuration separate from Ghostty's byte budget.
  source = replace(source, "    sixel: SixelStore = .{},", "    sixel: SixelStore = .{},\n    history_limit: usize = 10000,");
  source = replace(source, "    wrapper.sixel = .{};", "    wrapper.history_limit = scrollback_limit;\n    wrapper.sixel = .{};");
  source = replace(source, "    wrapper.stream.nextSlice(data[0..len]) catch return;", "    wrapper.stream.nextSlice(data[0..len]) catch return;\n    trimHistory(wrapper);");
  return source;
});

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("const ImageResponseHandler = struct")) return source;
  source = replace(source, "const ResponseStream = stream.Stream(ResponseHandler);", `const ResponseStream = stream.Stream(ResponseHandler);

// Specialize the parser at the write boundary. Ordinary output keeps the
// original handler with no per-character image branch or image lookup.
const ImageResponseHandler = struct {
    base: *ResponseHandler,
    pub fn vt(self: *ImageResponseHandler, comptime action: Action.Tag, value: Action.Value(action)) !void {
        self.base.sixel.beforeAction(self.base.terminal, action, value);
        try self.base.vt(action, value);
    }
    pub fn observeControl(self: *ImageResponseHandler, state: anytype, ch: u8) !void {
        try self.base.observeControl(state, ch);
    }
    pub fn graphicsQuery(self: *ImageResponseHandler, input: anytype) !bool {
        return self.base.graphicsQuery(input);
    }
    pub fn cancelDcs(self: *ImageResponseHandler) void { self.base.cancelDcs(); }
};
const ImageResponseStream = stream.Stream(ImageResponseHandler);

// Keep the specialized parser's code and stack frame out of the text hot path.
noinline fn writeWithImageTracking(wrapper: *TerminalWrapper, input: []const u8) !void {
    // Transfer both state fields, including partial UTF-8/DCS/OSC. The canonical
    // handler owns buffers; the temporary stream borrows them without deinit.
    var images: ImageResponseStream = .{
        .handler = .{ .base = &wrapper.stream.handler },
        .parser = wrapper.stream.parser,
        .utf8decoder = wrapper.stream.utf8decoder,
    };
    defer {
        wrapper.stream.parser = images.parser;
        wrapper.stream.utf8decoder = images.utf8decoder;
    }
    try images.nextSlice(input);
}`);
  return replace(source, "    wrapper.stream.nextSlice(data[0..len]) catch return;", `    if (wrapper.sixel.images.count() == 0) {
        // New placement already requests final collection, even when the image
        // and its overwrite arrive together in this previously image-free write.
        wrapper.sixel.collection_pending = true;
        wrapper.stream.nextSlice(data[0..len]) catch return;
    } else {
        writeWithImageTracking(wrapper, data[0..len]) catch return;
    }`);
});

// Focus reports, colour scheme reports, bells and notifications. See
// attention_api.zig.
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("bell_count: u32")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", "    clipboard: std.ArrayList(u8) = .{},\n    notifications: std.ArrayList(u8) = .{},\n    bell_count: u32 = 0,\n    light: bool = false,");
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        self.notifications.deinit(self.alloc);");
  source = replace(source, "            .bell,\n", "");
  source = replace(source, "            .show_desktop_notification,\n", "");
  source = replace(source, "            // Actions that require no response", `            .bell => self.bell_count +%= 1,
            .show_desktop_notification => {
                // A bounded queue: a program printing notifications in a loop
                // must not grow the host's memory.
                const size = value.title.len + 1 + value.body.len;
                if (value.title.len + value.body.len > 0 and size <= 8192 and self.notifications.items.len + 4 + size <= 64 * 1024) {
                    var length: [4]u8 = undefined;
                    std.mem.writeInt(u32, &length, @intCast(size), .little);
                    try self.notifications.appendSlice(self.alloc, &length);
                    try self.notifications.appendSlice(self.alloc, value.title);
                    try self.notifications.append(self.alloc, 0);
                    try self.notifications.appendSlice(self.alloc, value.body);
                }
            },
            // Actions that require no response`);
  source = replace(source, `            .color_scheme => {
                // Not supported in WASM context
            },`, "            .color_scheme => try self.reportColorScheme(),");
  // Enabling 1004 reports the current focus at once, as Ghostty does.
  source = replace(source, "        switch (mode) {", `        if (mode == .focus_event and enabled) try self.reportFocus();
        switch (mode) {`);
  source = replace(source, "    fn kittyColorOperation", `    pub fn reportFocus(self: *ResponseHandler) !void {
        try self.response_buffer.appendSlice(self.alloc, if (self.terminal.flags.focused) "\\x1b[I" else "\\x1b[O");
    }

    pub fn reportColorScheme(self: *ResponseHandler) !void {
        try self.response_buffer.appendSlice(self.alloc, if (self.light) "\\x1b[?997;2n" else "\\x1b[?997;1n");
    }

    fn kittyColorOperation`);
  return source;
});

// Mode and version queries, the title stack and progress reports. See
// report_api.zig.
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("title_stack_len: u8")) return source;
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", `    clipboard: std.ArrayList(u8) = .{},
    title_stack: [10]std.ArrayList(u8) = [_]std.ArrayList(u8){.{}} ** 10,
    title_stack_len: u8 = 0,
    version: [64]u8 = undefined,
    version_len: u8 = 0,
    progress: u32 = 0,
    progress_revision: u32 = 0,`);
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        for (&self.title_stack) |*entry| entry.deinit(self.alloc);");
  for (const action of ["request_mode", "request_mode_unknown", "xtversion", "progress_report", "title_push", "title_pop"]) {
    source = replace(source, `            .${action},\n`, "");
  }
  source = replace(source, "            // Actions that require no response", `            .request_mode => try self.reportMode(value.mode),
            .request_mode_unknown => try self.reportModeState(value.mode, value.ansi, 0),
            .xtversion => try self.reportVersion(),
            .progress_report => {
                const percent: u32 = if (value.progress) |p| @min(p, 100) else 255;
                self.progress = @as(u32, @intCast(@intFromEnum(value.state))) | (percent << 8);
                self.progress_revision +%= 1;
            },
            // Only the window title; Ghostty's parser drops other targets.
            .title_push => try self.pushTitle(),
            .title_pop => self.popTitle(),
            // Actions that require no response`);
  // A full reset empties the title stack with the title.
  source = replace(source, "self.title.clearRetainingCapacity(); self.title_revision +%= 1;", "self.title.clearRetainingCapacity(); self.title_revision +%= 1; self.clearTitleStack();");
  source = replace(source, "    fn kittyColorOperation", `    // DECRPM, as Ghostty answers it, except that modes the core tracks but
    // Tessera does not act on are reported as unrecognised: mouse report
    // formats other than SGR (Tessera always sends SGR) and synchronized
    // output. A program told one is supported would rely on it.
    fn reportMode(self: *ResponseHandler, mode: modespkg.Mode) !void {
        const tag: modespkg.ModeTag = @bitCast(@intFromEnum(mode));
        const state: u8 = switch (mode) {
            .mouse_format_utf8, .mouse_format_urxvt, .mouse_format_sgr_pixels, .synchronized_output => 0,
            else => if (self.terminal.modes.get(mode)) 1 else 2,
        };
        try self.reportModeState(tag.value, tag.ansi, state);
    }

    fn reportModeState(self: *ResponseHandler, mode: u16, ansi: bool, state: u8) !void {
        var buf: [32]u8 = undefined;
        try self.response_buffer.appendSlice(self.alloc, try std.fmt.bufPrint(&buf, "\\x1b[{s}{d};{d}$y", .{ if (ansi) "" else "?", mode, state }));
    }

    fn reportVersion(self: *ResponseHandler) !void {
        try self.response_buffer.appendSlice(self.alloc, "\\x1bP>|Tessera");
        if (self.version_len > 0) {
            try self.response_buffer.append(self.alloc, ' ');
            try self.response_buffer.appendSlice(self.alloc, self.version[0..self.version_len]);
        }
        try self.response_buffer.appendSlice(self.alloc, "\\x1b\\\\");
    }

    // xterm keeps ten titles; a push past that drops the oldest, and a pop
    // with none saved does nothing.
    fn pushTitle(self: *ResponseHandler) !void {
        var saved: std.ArrayList(u8) = .{};
        try saved.appendSlice(self.alloc, self.title.items);
        if (self.title_stack_len == self.title_stack.len) {
            self.title_stack[0].deinit(self.alloc);
            std.mem.copyForwards(std.ArrayList(u8), self.title_stack[0 .. self.title_stack.len - 1], self.title_stack[1..]);
            self.title_stack_len -= 1;
        }
        self.title_stack[self.title_stack_len] = saved;
        self.title_stack_len += 1;
    }

    fn popTitle(self: *ResponseHandler) void {
        if (self.title_stack_len == 0) return;
        self.title_stack_len -= 1;
        self.title.deinit(self.alloc);
        self.title = self.title_stack[self.title_stack_len];
        self.title_stack[self.title_stack_len] = .{};
        self.title_revision +%= 1;
    }

    pub fn clearTitleStack(self: *ResponseHandler) void {
        for (self.title_stack[0..self.title_stack_len]) |*entry| entry.deinit(self.alloc);
        self.title_stack = [_]std.ArrayList(u8){.{}} ** 10;
        self.title_stack_len = 0;
    }

    fn kittyColorOperation`);
  return source;
});

// Upstream reads DECRQM only for DEC modes (CSI ? Pd $ p); its own code for
// ANSI modes (CSI Pa $ p, one intermediate) was unreachable. Any other single
// intermediate is still ignored there.
await edit("src/terminal/stream.zig", (source) => source.includes("1, 2 => decrqm: {") ? source : replace(source,
  "                'p' => switch (input.intermediates.len) {\n                    2 => decrqm: {",
  "                'p' => switch (input.intermediates.len) {\n                    1, 2 => decrqm: {"));

// Kitty keyboard protocol: answer the query (CSI ? u) with the active
// screen's flags, as Ghostty does, so programs know the protocol is there.
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes(".kitty_keyboard_query => {")) return source;
  source = replace(source, "            .kitty_keyboard_query,\n", "");
  return replace(source, "            // Actions that require no response", `            .kitty_keyboard_query => {
                var buf: [16]u8 = undefined;
                try self.response_buffer.appendSlice(self.alloc, try std.fmt.bufPrint(&buf, "\\x1b[?{d}u", .{self.terminal.screens.active.kitty_keyboard.current().int()}));
            },
            // Actions that require no response`);
});

// Capability and setting queries (XTGETTCAP, DCS + q; DECRQSS, DCS $ q) and
// in-band size reports (mode 2048). See query_api.zig. DCS strings that are
// not Sixel go to Ghostty's DCS parser, and its commands are answered as
// Ghostty's app answers them.
await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("dcs: DcsHandler")) return source;
  source = replace(source, 'const SixelStore = @import("sixel_store.zig").Store;', `const SixelStore = @import("sixel_store.zig").Store;
const DcsHandler = @import("../dcs.zig").Handler;
const DcsCommand = @import("../dcs.zig").Command;`);
  source = replace(source, "    clipboard: std.ArrayList(u8) = .{},", `    clipboard: std.ArrayList(u8) = .{},
    // A query names a few capabilities; longer strings are dropped.
    dcs: DcsHandler = .{ .max_bytes = 4096 },
    term_name: [64]u8 = undefined,
    term_name_len: u8 = 0,
    size_reported: [4]u32 = .{ 0, 0, 0, 0 },`);
  source = replace(source, "        self.clipboard.deinit(self.alloc);", "        self.clipboard.deinit(self.alloc);\n        self.dcs.deinit();");
  source = replace(source,
    "            .dcs_hook => self.sixel.begin(self.alloc, self.terminal, value),\n            .dcs_put => self.sixel.put(self.alloc, value),\n            .dcs_unhook => try self.sixel.end(self.alloc, self.terminal),",
    `            .dcs_hook => {
                self.sixel.begin(self.alloc, self.terminal, value);
                // An interrupted string may have left the parser's state.
                self.dcs.deinit();
                if (!self.sixel.active) _ = self.dcs.hook(self.alloc, value);
            },
            .dcs_put => if (self.sixel.active) self.sixel.put(self.alloc, value) else {
                _ = self.dcs.put(value);
            },
            .dcs_unhook => {
                try self.sixel.end(self.alloc, self.terminal);
                if (self.dcs.unhook()) |command| {
                    var owned = command;
                    defer owned.deinit();
                    try self.dcsCommand(&owned);
                }
            },`);
  source = replace(source, "    pub fn cancelDcs(self: *ResponseHandler) void { self.sixel.active = false; self.sixel.decoder.deinit(self.alloc); }",
    "    pub fn cancelDcs(self: *ResponseHandler) void { self.sixel.active = false; self.sixel.decoder.deinit(self.alloc); self.dcs.deinit(); }");
  // Enabling 2048 reports the size at once, as Ghostty does.
  source = replace(source, "        switch (mode) {", `        if (mode == .in_band_size_reports and enabled) try self.reportSize();
        switch (mode) {`);
  source = replace(source, "    fn kittyColorOperation", `    fn dcsCommand(self: *ResponseHandler, command: *DcsCommand) !void {
        switch (command.*) {
            .tmux => {},
            .xtgettcap => |*request| while (request.next()) |name| try self.reportCapability(name),
            .decrqss => |request| try self.reportSetting(request),
        }
    }

    // XTGETTCAP answers from Ghostty's terminfo, less what Tessera doesn't
    // do, and TN is the TERM programs were started with. Unknown names get
    // xterm's "not found", so a program needn't wait for a timeout.
    fn reportCapability(self: *ResponseHandler, name: []const u8) !void {
        if (name.len == 0 or name.len > 64) return;
        if (std.mem.eql(u8, name, "544E") and self.term_name_len > 0) {
            try self.response_buffer.appendSlice(self.alloc, "\\x1bP1+r544E=");
            for (self.term_name[0..self.term_name_len]) |c| {
                var hex: [2]u8 = undefined;
                _ = try std.fmt.bufPrint(&hex, "{X:0>2}", .{c});
                try self.response_buffer.appendSlice(self.alloc, &hex);
            }
            try self.response_buffer.appendSlice(self.alloc, "\\x1b\\\\");
            return;
        }
        if (!std.mem.eql(u8, name, "544E")) {
            if (capabilities.get(name)) |reply| return self.response_buffer.appendSlice(self.alloc, reply);
        }
        try self.response_buffer.appendSlice(self.alloc, "\\x1bP0+r");
        try self.response_buffer.appendSlice(self.alloc, name);
        try self.response_buffer.appendSlice(self.alloc, "\\x1b\\\\");
    }

    // DECRPSS, as Ghostty writes it.
    fn reportSetting(self: *ResponseHandler, request: DcsCommand.DECRQSS) !void {
        var buf: [128]u8 = undefined;
        var payload: []const u8 = "";
        switch (request) {
            .none => {},
            .sgr => {
                const attributes = try self.terminal.printAttributes(buf[0 .. buf.len - 1]);
                buf[attributes.len] = 'm';
                payload = buf[0 .. attributes.len + 1];
            },
            .decscusr => {
                const blink = self.terminal.modes.get(.cursor_blinking);
                const style: u8 = switch (self.terminal.screens.active.cursor.cursor_style) {
                    .block, .block_hollow => if (blink) 1 else 2,
                    .underline => if (blink) 3 else 4,
                    .bar => if (blink) 5 else 6,
                };
                payload = try std.fmt.bufPrint(&buf, "{d} q", .{style});
            },
            .decstbm => payload = try std.fmt.bufPrint(&buf, "{d};{d}r", .{ self.terminal.scrolling_region.top + 1, self.terminal.scrolling_region.bottom + 1 }),
            .decslrm => if (self.terminal.modes.get(.enable_left_and_right_margin)) {
                payload = try std.fmt.bufPrint(&buf, "{d};{d}s", .{ self.terminal.scrolling_region.left + 1, self.terminal.scrolling_region.right + 1 });
            },
        }
        try self.response_buffer.appendSlice(self.alloc, if (payload.len > 0) "\\x1bP1$r" else "\\x1bP0$r");
        try self.response_buffer.appendSlice(self.alloc, payload);
        try self.response_buffer.appendSlice(self.alloc, "\\x1b\\\\");
    }

    // CSI 48 ; rows ; cols ; height ; width t, in cells and pixels.
    pub fn reportSize(self: *ResponseHandler) !void {
        const size = [4]u32{ self.terminal.rows, self.terminal.cols, self.terminal.height_px, self.terminal.width_px };
        self.size_reported = size;
        var buf: [64]u8 = undefined;
        try self.response_buffer.appendSlice(self.alloc, try std.fmt.bufPrint(&buf, "\\x1b[48;{d};{d};{d};{d}t", .{ size[0], size[1], size[2], size[3] }));
    }

    fn kittyColorOperation`);
  source = replace(source, "const ResponseStream = stream.Stream(ResponseHandler);", `const ResponseStream = stream.Stream(ResponseHandler);

// Ghostty's terminfo for XTGETTCAP, without what Tessera doesn't do: styled
// and coloured underlines (the renderer draws one plain underline) and
// synchronized output (2026 is reported unrecognised).
const capabilities = blk: {
    @setEvalBranchQuota(1_000_000);
    const Source = @import("../../terminfo/Source.zig");
    const ghostty = @import("../../terminfo/main.zig").ghostty;
    var kept: [ghostty.capabilities.len]Source.Capability = undefined;
    var count: usize = 0;
    for (ghostty.capabilities) |cap| {
        if (std.mem.eql(u8, cap.name, "Su") or std.mem.eql(u8, cap.name, "Smulx") or
            std.mem.eql(u8, cap.name, "Setulc") or std.mem.eql(u8, cap.name, "Sync")) continue;
        kept[count] = cap;
        count += 1;
    }
    const final = kept[0..count].*;
    const source: Source = .{ .names = ghostty.names, .capabilities = &final };
    break :blk source.xtgettcapMap();
};`);
  return source;
});
