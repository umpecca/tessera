# Task 226: Shell integration

Status: complete (iPad and Linux host checks pending)

## Request

Set up the shell automatically, as Ghostty does, so the working directory
(task 209), prompt jumps and Copy Command Output (task 211) and command
finished notices (task 227) work without pasting hooks into `~/.zshrc`.

## Findings

- Tessera starts the shell itself (`$TESSERA_TERMINAL_SHELL`, `$SHELL`,
  `/bin/sh`), as a non-login interactive shell, so it can choose how.
- Ghostty's integration scripts are GPLv3 (from Kitty's), so none of them
  is copied; the startup mechanisms are well known: zsh reads
  `$ZDOTDIR/.zshenv` first and reads `ZDOTDIR` again for each later file;
  bash takes `--rcfile` in place of `~/.bashrc` for a non-login interactive
  shell.
- Prompt themes rebuild `PS1` in their own precmd hooks; a mark added to
  `PS1` in a hook run before them is lost on the first prompt. The prompt
  start can be printed from precmd instead; only the prompt end (B) has to
  be in `PS1`, and a one-line prompt doesn't need it (task 211).
- bash 4.4 added `PS0`, expanded in the shell itself as a command starts; an
  arithmetic substring offset (`${x:running=1:0}`) sets a variable there
  without output or a fork. `HISTCMD` advances only when the command was
  saved, so a command kept out of history (`ignorespace`) can be left
  unnamed. bash 3.2 (macOS `/bin/bash`) has neither; it isn't set up.
- Checked against zsh 5.9 and bash 5.2.37 built in the scratchpad (macOS has
  only 3.2), and 3.2.
- A scripts folder deleted while Tessera runs (a cleared cache) would leave
  zsh pointed at nothing, skipping the user's own startup files too; a
  once-per-process install allowed that and the repeated test run showed it.
- Users who followed the README have its hooks in `~/.zshrc` (this host
  does): marks are sent twice. Harmless for the core; task 227 handles it
  for notices.

## Changes

- `internal/shellintegration` (new): the scripts, embedded:
  - `zsh/.zshenv`: restores `ZDOTDIR` (from `TESSERA_ZSH_ZDOTDIR`, or unset),
    reads the user's `.zshenv`, then for an interactive shell
    `tessera-integration.zsh`: OSC 7 now and on `chpwd`; a first precmd hook
    sending D with the status (if a command ran) and A; a hook kept last
    adding B to `PS1`; preexec sending C with `cmdline_url` (first line,
    200 characters, none for a space-led command under `hist_ignore_space`).
    Percent-encoding without forks. `TESSERA_SHELL_INTEGRATION=0` skips it.
  - `bash/tessera.bash`: reads `~/.bashrc`, then on bash 4.4+: PROMPT_COMMAND
    (string or array) wrapped with a first function (D, status handed on)
    and a last one (OSC 7 when the directory changed, A and B in `PS1`);
    `PS0` setting the running flag and, in a subshell, sending C with the
    command line from `history 1` when `HISTCMD` advanced.
  - `Root()` writes them, by content hash, under the user cache folder,
    checking (and putting back) on every shell start, each file written
    privately and renamed; `Configure` sets `ZDOTDIR` (keeping the user's in
    `TESSERA_ZSH_ZDOTDIR`) for zsh, `--rcfile` for bash, nothing for others.
- `internal/terminal`: `Launch{TERM, ShellIntegration}` replaces the TERM
  argument of `Start` and `Manager.Attach`; Unix starts use the integration
  when on (a failure to write the scripts starts the shell without it).
- `migrations/051_user_settings_shell_integration.sql`,
  `internal/store/session.go`: `terminal_shell_integration_off` (default 0,
  stored as off so a page from before sends nothing that turns it off);
  `internal/httpapi/terminal.go` passes it.
- `web/app.js`: **Settings → Terminal → Shell integration**; the "No command
  output" message points there.
- `README.md` (the zsh snippets replaced), `CHANGELOG.md`.

## Validation

- `internal/shellintegration`: install by content, put back after a change
  or after the folder is removed, no leftover files; `Configure` for zsh
  (with and without `ZDOTDIR`, a login `-zsh`), bash, and others unchanged.
- `internal/terminal/shell_integration_unix_test.go`: a real zsh and bash
  (4.4+, skipped otherwise) started through `Start` send OSC 7, A, B, C with
  the command line, the output and D with status 1; six repeated runs. With
  the setting off, zsh sends no marks and `ZDOTDIR` is unset.
- `internal/store`: the setting round-trips and is on for new users; the
  retire-audio migration fixture updated.
- By hand in a PTY, zsh 5.9 with a theme rebuilding `PS1` and
  `hist_ignore_space`: marks on every prompt including the first, status 1
  after `false`, no command line for a space-led command, nothing for an
  empty line, the user's `.zshenv` read, `ZDOTDIR` restored, a nested zsh
  untouched, OSC 7 after `cd` into a folder with a space. bash 5.2 with
  `HISTCONTROL=ignoreboth` and a `PROMPT_COMMAND` theme: the same, with the
  status reaching the theme. bash 3.2: `~/.bashrc` only.
- Real host, a built binary, this account's zsh: prompt marks present, the
  pane's directory followed `cd /tmp`, Copy Command Output found the last
  output.
- Full JavaScript suite and `go test ./...` pass (see task 227).
- First tagged run: the Windows job failed two of the package's tests,
  which assumed Unix (a 0644 mode check, and paths compared with `/` where
  `filepath.Join` gives `\`). The tests now skip the mode on Windows and
  build expected paths with `filepath.Join`, and the cache test points
  `LocalAppData` at its temporary folder too. The integration itself only
  runs on Unix.
- Not yet run on Linux (CI will run the bash test with bash 5) or on the
  iPad.
