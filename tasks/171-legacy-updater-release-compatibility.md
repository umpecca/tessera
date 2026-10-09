# Preserve the upgrade path from legacy audio releases

Status: completed

Older updaters reject v1.9.1 because its release lacks their required LAME
companion. Preserve the original v1.9.0 platform companions and source/license
with pinned checksum/size verification. Add them to future release packaging
without restoring Audio station/capture code or encoder builds.

Prepare the six verified assets locally for repairing the public v1.9.1 release.
Validate packaging and the old/new updater behavior. Publish the repair after
explicit user approval.

## Implemented and verified

- Added a six-file manifest pinned to v1.9.0 release sizes and SHA-256 hashes.
  Packaging downloads only verified original companions for Linux amd64/arm64,
  macOS arm64, and Windows amd64, plus source and license. Existing mismatches
  fail rather than being overwritten; failed verification never creates files.
- The release workflow prepares these files before creating future releases.
  Current updater/runtime behavior stays independent of LAME. Documentation
  explains why the assets remain and how to prepare a release repair.
- All six genuine assets are staged at `.cache/review/legacy-update-171/assets`.
  The user explicitly approved uploading these six files to v1.9.1.
- Five packaging tests pass. Current updater tests pass, including ignoring a
  legacy companion in release metadata while preserving an installed copy.
- An isolated copy of the actual v1.9.0 updater reproduced the missing companion
  failure against v1.9.1 metadata, then successfully installed an executable and
  the original Windows companion when the verified asset was added. Test source
  and results are in `.cache/review/legacy-update-171/old-updater`.
- Uploaded all six files to the existing public v1.9.1 release without clobbering
  assets. Re-downloaded the new public URLs and verified their sizes/checksums;
  all eight original Tessera/helper asset sizes and digests are unchanged.
  The public latest-release endpoint advertises the compatibility assets.
  Report: `.cache/review/legacy-update-171/repair-result.json`.
