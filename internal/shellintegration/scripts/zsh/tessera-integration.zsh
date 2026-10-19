# Tessera's zsh hooks. They mark each prompt and command (OSC 133), which
# Tessera uses for prompt jumps, Copy Command Output and notices when a long
# command finishes, and report the working directory (OSC 7), which sets the
# pane's directory. Set TESSERA_SHELL_INTEGRATION=0 before this runs, or
# turn off Shell integration in Tessera's settings, to go without.

[[ -n ${_tessera_hooks-} || ${TESSERA_SHELL_INTEGRATION-} == 0 ]] && return
typeset -g _tessera_hooks=1 _tessera_running=
autoload -Uz add-zsh-hook

# Percent-encodes $1 (bytes outside a safe set) into REPLY, without forking.
_tessera_url_encode() {
  emulate -L zsh
  local LC_ALL=C text=$1 ch code
  REPLY=
  local -i i
  for (( i = 1; i <= ${#text}; i++ )); do
    ch=${text[i]}
    if [[ $ch == [A-Za-z0-9/._~-] ]]; then
      REPLY+=$ch
    else
      builtin printf -v code '%%%02X' "'$ch"
      REPLY+=$code
    fi
  done
}

_tessera_report_cwd() {
  emulate -L zsh
  local REPLY
  _tessera_url_encode $PWD
  builtin printf '\e]7;file://%s%s\e\\' $HOST $REPLY
}

# First of the precmd hooks: the status of the command that just ran, then
# the start of the prompt, which is drawn next.
_tessera_precmd() {
  local exit_status=$?
  if [[ -n $_tessera_running ]]; then
    builtin printf '\e]133;D;%s\e\\' $exit_status
    _tessera_running=
  fi
  builtin printf '\e]133;A\e\\'
  # The end of the prompt has to be in PS1, which prompt themes often
  # rebuild in their own precmd hooks: mark it in a hook kept last (from
  # the second prompt on; a one-line prompt doesn't need it).
  precmd_functions=(${precmd_functions:#_tessera_mark_prompt} _tessera_mark_prompt)
  return $exit_status
}

_tessera_mark_prompt() {
  [[ $PS1 == *$'\e]133;B'* ]] || PS1+=$'%{\e]133;B\e\\%}'
}

# The command line as typed, first line only and at most 200 characters,
# except one kept out of history by starting with a space.
_tessera_preexec() {
  emulate -L zsh
  _tessera_running=1
  local line=${1%%$'\n'*} REPLY=
  if [[ -n $line && ! ( -o hist_ignore_space && $line == ' '* ) ]]; then
    _tessera_url_encode ${line[1,200]}
    builtin printf '\e]133;C;cmdline_url=%s\e\\' $REPLY
  else
    builtin printf '\e]133;C\e\\'
  fi
}

add-zsh-hook precmd _tessera_precmd
add-zsh-hook preexec _tessera_preexec
add-zsh-hook chpwd _tessera_report_cwd
_tessera_report_cwd
