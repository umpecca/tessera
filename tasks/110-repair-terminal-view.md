# Task 110: Repair terminal view command

Status: complete

Add Repair Terminal View to the command bar for an active, initialized
terminal, with shortcut code RV. Clear cached fit and sent-size decisions,
schedule a fresh measurement, resend geometry over the existing connection,
and request a full redraw. Preserve the shell and terminal contents.

Validation: frontend tests and Go web asset tests.
