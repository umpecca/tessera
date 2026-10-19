# Tessera shell integration for bash 4.4 and later. Tessera starts bash with
# --rcfile pointing here, so this file runs instead of ~/.bashrc: it reads
# ~/.bashrc as bash would have, then adds Tessera's hooks. They mark each
# prompt and command (OSC 133), which Tessera uses for prompt jumps, Copy
# Command Output and notices when a long command finishes, and report the
# working directory (OSC 7), which sets the pane's directory. Set
# TESSERA_SHELL_INTEGRATION=0 in ~/.bashrc, or turn off Shell integration in
# Tessera's settings, to go without. Older bash just reads ~/.bashrc.

[[ -r ~/.bashrc ]] && builtin source ~/.bashrc

if [[ $- == *i* && -z ${_tessera_hooks-} && ${TESSERA_SHELL_INTEGRATION-} != 0 ]] &&
  (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  _tessera_hooks=1
  _tessera_running=
  _tessera_status=0
  _tessera_cwd=
  _tessera_history=
  _tessera_none=

  # Percent-encodes $1 (bytes outside a safe set) into REPLY, without forking.
  _tessera_url_encode() {
    local LC_ALL=C text=$1 ch code i
    REPLY=
    for (( i = 0; i < ${#text}; i++ )); do
      ch=${text:i:1}
      if [[ $ch == [A-Za-z0-9/._~-] ]]; then
        REPLY+=$ch
      else
        builtin printf -v code '%%%02X' "'$ch"
        REPLY+=$code
      fi
    done
  }

  # First in PROMPT_COMMAND: the status of the command that just ran,
  # handed on to whatever runs next.
  _tessera_prompt_start() {
    _tessera_status=$?
    if [[ -n $_tessera_running ]]; then
      builtin printf '\e]133;D;%s\e\\' "$_tessera_status"
      _tessera_running=
    fi
    return $_tessera_status
  }

  # Last in PROMPT_COMMAND, after anything that rebuilds PS1.
  _tessera_prompt_end() {
    if [[ $PWD != "$_tessera_cwd" ]]; then
      _tessera_cwd=$PWD
      local REPLY
      _tessera_url_encode "$PWD"
      builtin printf '\e]7;file://%s%s\e\\' "$HOSTNAME" "$REPLY"
    fi
    # Prompt escapes: \e is ESC and \\ a backslash, between \[ and \].
    [[ $PS1 == *']133;A'* ]] || PS1='\[\e]133;A\e\\\]'"$PS1"'\[\e]133;B\e\\\]'
    _tessera_history=$HISTCMD
    return $_tessera_status
  }

  # Runs from PS0, in a subshell, as a command starts: the command line,
  # first line only and at most 200 characters, if bash saved it in its
  # history (a command kept out by starting with a space isn't named).
  _tessera_command_mark() {
    local line REPLY=
    if [[ $HISTCMD != "$_tessera_history" ]] && line=$(HISTTIMEFORMAT= builtin history 1) &&
      [[ $line =~ ^[[:space:]]*[0-9]+[*]?[[:space:]]+(.*)$ ]]; then
      line=${BASH_REMATCH[1]}
      line=${line%%$'\n'*}
      _tessera_url_encode "${line:0:200}"
    fi
    if [[ -n $REPLY ]]; then
      builtin printf '\e]133;C;cmdline_url=%s\e\\' "$REPLY"
    else
      builtin printf '\e]133;C\e\\'
    fi
  }

  # PS0 is expanded as each command line starts. The substring expansion
  # sets _tessera_running in this shell (an arithmetic offset) and adds
  # nothing to the output.
  PS0='${_tessera_none:_tessera_running=1:0}$(_tessera_command_mark)'"${PS0-}"

  if [[ $(builtin declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
    PROMPT_COMMAND=(_tessera_prompt_start "${PROMPT_COMMAND[@]}" _tessera_prompt_end)
  else
    PROMPT_COMMAND=_tessera_prompt_start$'\n'"${PROMPT_COMMAND-}"$'\n'_tessera_prompt_end
  fi
fi
