# Tessera shell integration for zsh. Tessera starts zsh with ZDOTDIR set to
# this folder so that this file is read first. It puts ZDOTDIR back, so the
# rest of startup (.zprofile, .zshrc, .zlogin) and any zsh started later use
# your own files, reads your .zshenv, then adds Tessera's hooks.

if [[ -n ${TESSERA_ZSH_ZDOTDIR+set} ]]; then
  export ZDOTDIR=$TESSERA_ZSH_ZDOTDIR
  unset TESSERA_ZSH_ZDOTDIR
else
  unset ZDOTDIR
fi

typeset -g _tessera_integration=${${(%):-%x}:A:h}/tessera-integration.zsh
[[ -r ${ZDOTDIR:-$HOME}/.zshenv ]] && builtin source -- ${ZDOTDIR:-$HOME}/.zshenv
[[ -o interactive && -r $_tessera_integration ]] && builtin source -- $_tessera_integration
unset _tessera_integration
