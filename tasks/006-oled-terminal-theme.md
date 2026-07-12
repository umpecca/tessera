# Task 006: OLED terminal theme

Status: complete

Add an `OLED Terminal` appearance option inspired by dense tmux and Emacs
layouts. It uses true black (`#000000`) for the workspace, pane, editor, and
terminal backgrounds, with restrained gray text and monochrome interaction
states.

The theme hides the decorative top title tabs with theme-scoped CSS while
leaving those elements and their behavior intact for every other theme. The
compact bottom status strip remains visible as a modeline for pane controls and
context.
