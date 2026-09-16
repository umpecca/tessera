# Task 114: Reduce background work

Status: complete

Use a 30-second health-check interval while hidden instead of five seconds.
Restore the five-second cadence and existing immediate health check on return.
Keep sleep detection and terminal streams running. Skip hidden-tab terminal
countdown DOM updates and worksheet spinner document edits; Older Mac mode
also uses a steady worksheet spinner.

Validation: deterministic polling cadence/timer replacement test and frontend
and web asset checks.
