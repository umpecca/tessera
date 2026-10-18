# Task 201: Document higher-quality audio streams

Status: complete

## Request

An option to stream terminal audio at higher quality when running locally.

## Findings

Tessera doesn't encode stream audio. The producer (the `tessera-audio` CLI,
maintained in its own repository) encodes Opus at a bitrate it chooses:
16–256 kbps, default 128 (task 168). Tessera relays the packets, and the
browser decodes at 48 kHz in the stream's channel count, so nothing in this
repository limits quality.

The user chose to use the producer's existing bitrate option rather than add a
Tessera setting that `tessera-audio` would read from the capability reply, or a
lossless PCM stream format. Both alternatives need changes in the
`tessera-audio` repository.

## Changes

- `docs/terminal-audio.md`: a Stream quality section saying the producer
  sets quality, and recommending 256 kbps for local or LAN use.

## Validation

- Documentation only. The bitrate range comes from task 168. The CLI isn't
  installed on this machine, so the docs point to `tessera-audio stream
  --help` for the option's exact name rather than stating it.
