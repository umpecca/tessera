# Task 093: Build only on release tags

Status: complete

The user requested tag-only builds, authorizing this workflow change.

- Change Terminal core to run only on pushed `v*` tags, matching Release.
- Remove its branch-push and pull-request triggers.
- Retain existing build and verification jobs and artifact-cleanup scheduling.

Validation: inspected all workflow triggers and checked the diff for whitespace
errors. Release already used the desired tag filter. No application code changed.
