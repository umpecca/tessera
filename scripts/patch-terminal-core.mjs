import fs from "node:fs/promises";
import path from "node:path";

// Applied only to the pinned source checkout, after ghostty-web's WASM patch.
const root = path.resolve(process.argv[2] || ".cache/sixel/ghostty-web/ghostty");
const awaitExtension = await fs.readFile("internal/terminalcore/source/sixel_api.zig", "utf8") + await fs.readFile("internal/terminalcore/source/snapshot_api.zig", "utf8");
async function edit(file, transform) {
  const target = path.join(root, file);
  const source = await fs.readFile(target, "utf8");
  await fs.writeFile(target, transform(source.replaceAll("\r\n", "\n")));
}
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Pinned Ghostty source changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
for (const name of ["sixel.zig", "sixel_store.zig", "snapshot.zig"]) {
  await fs.copyFile(`internal/terminalcore/source/${name}`, path.join(root, "src/terminal/c", name));
}
await edit("src/terminal/page.zig", (source) => {
  if (source.includes("sixel: u18")) return source;
  source = replace(source, "_padding: u18 = 0,", "sixel: u18 = 0,");
  source = replace(source, "pub fn isEmpty(self: Cell) bool {", "pub fn isEmpty(self: Cell) bool {\n        if (self.sixel != 0) return false;");
  source = replace(source, "if (cell.hasText()) return true;", "if (cell.hasText() or cell.sixel != 0) return true;");
  return source;
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
await edit("src/lib_vt.zig", (source) => {
  const marker = '@export(&c.terminal_write, .{ .name = "ghostty_terminal_write" });';
  source = source.replace(/^\s*@export\(&c\.terminal\.sixel_[^\n]+\n/gm, "");
  const exports = ["version", "configure", "geometry", "image_count", "image_info", "image_pixels", "image_settings", "image_settings_read", "clear_images", "tiles", "snapshot_export", "snapshot_release", "snapshot_data", "snapshot_import", "clipboard_read"];
  return replace(source, marker, marker + "\n" + exports.map((name) => `        @export(&c.terminal.sixel_${name}, .{ .name = "tessera_sixel_${name}" });`).join("\n"));
});
for (const file of ["props_uucode.zig", "symbols_uucode.zig"]) {
  await edit(`src/unicode/${file}`, (source) => source.replace("try stdout.end();", "try stdout.interface.flush();"));
}

await edit("src/terminal/c/terminal.zig", (source) => source.replace(
  /\.full_reset => \{[^\n]*self\.terminal\.fullReset\(\); \},/,
  ".full_reset => { const cw = self.sixel.cell_width; const ch = self.sixel.cell_height; const limit = self.sixel.memory_limit; const placeholders = self.sixel.show_placeholders; self.sixel.deinit(self.alloc); self.sixel.cell_width = cw; self.sixel.cell_height = ch; self.sixel.memory_limit = limit; self.sixel.show_placeholders = placeholders; self.terminal.fullReset(); },"
));

await edit("src/terminal/c/terminal.zig", (source) => {
  if (source.includes("// Tessera line limit")) return source;
  source = replace(source, ".max_scrollback = scrollback_limit,", ".max_scrollback = 64 * 1024 * 1024, // Tessera line limit is enforced below");
  // Keep the public wrapper's line-based configuration separate from Ghostty's byte budget.
  source = replace(source, "    sixel: SixelStore = .{},", "    sixel: SixelStore = .{},\n    history_limit: usize = 10000,");
  source = replace(source, "    wrapper.sixel = .{};", "    wrapper.history_limit = scrollback_limit;\n    wrapper.sixel = .{};");
  source = replace(source, "    wrapper.stream.nextSlice(data[0..len]) catch return;", "    wrapper.stream.nextSlice(data[0..len]) catch return;\n    trimHistory(wrapper);");
  return source;
});
