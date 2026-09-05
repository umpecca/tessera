# Task 096: Reduce redundant work during window interactions

Status: complete

First pass toward the requested usability and performance polish:
- Moving a pane should not remeasure content whose size has not changed.
- Geometry updates that round to the current bounds should do no work.
- Initial layout and pane-type changes must still measure their content.
- Refocusing the selected frontmost pane should preserve explicit keyboard
  focus requests without rebuilding selection UI or scheduling a save.

Follow-up review priorities: refresh/reconnect continuity, keyboard navigation
and modal focus, drag/resize responsiveness with many panes, idle CPU and
memory, and consistent loading/error/empty states. These need browser-level
verification and performance measurements before claiming broader polish.

Validation: all 177 frontend tests passed, including interaction regressions;
the web build, JavaScript syntax check, and diff whitespace check passed.
No live browser performance benchmark was run.
