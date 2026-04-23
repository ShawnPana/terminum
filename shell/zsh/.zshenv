# tdub ZDOTDIR shim. Runs for every zsh spawned inside tdub (shell, tmux
# panes). Source the user's real config first so their environment is
# unchanged, then ensure $TDUB_BIN stays on PATH — macOS path_helper
# (invoked from /etc/zprofile) otherwise wipes it on login shells.
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
[[ -n "$TDUB_BIN" ]] && export PATH="$TDUB_BIN:$PATH"
