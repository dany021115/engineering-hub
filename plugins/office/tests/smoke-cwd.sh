#!/bin/sh
# Smoke test for fix 9, outside `claude plugin test` (its mocks cannot see a
# lost cwd, nor a hook the engine skips in an agent's loop): a real `claude -p`
# session hires an agent in one repo of a temporary workspace, checks the folder
# that agent works in and that its post reaches the board.
#
# Usage: sh plugins/office/tests/smoke-cwd.sh   (runs one haiku session)
set -eu

# Git runs isolated from the configuration of whoever runs this: no global or
# system config, a fixed synthetic identity, no hooks and no signing. The office
# inherits it inside `claude -p`, so its own git calls run the same way.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Smoke Test'
export GIT_AUTHOR_EMAIL='smoke@example.com'
export GIT_COMMITTER_NAME='Smoke Test'
export GIT_COMMITTER_EMAIL='smoke@example.com'
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=core.hooksPath
export GIT_CONFIG_VALUE_0=/dev/null
export GIT_CONFIG_KEY_1=commit.gpgsign
export GIT_CONFIG_VALUE_1=false

plugin=$(cd "$(dirname "$0")/.." && pwd -P)
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
workspace=$(cd "$workspace" && pwd -P)

for repo in service web; do
  git init -q "$workspace/$repo"
  git -C "$workspace/$repo" commit -q --allow-empty -m 'chore: start'
done

out="$workspace/pwd.txt"
prompt="Call the mcp__office__hire tool exactly once with repo \"service\", worktree \"no\" and this task:
\"Run this Bash command: pwd > $out. Then call the mcp__office__post tool once with topic smoke and text smoke-post.\"
Then run this Bash command, which waits for that agent:
for i in \$(seq 90); do [ -s $out ] && break; sleep 2; done; sleep 10
Then call the mcp__office__board tool with query smoke and reply with its result alone."

cd "$workspace"
answer=$(printf '%s\n' "$prompt" | claude -p --model haiku \
  --plugin-dir "$plugin" \
  --setting-sources project,local \
  --strict-mcp-config \
  --allowedTools 'mcp__office__hire,mcp__office__board,Bash')

seen=$(cat "$out" 2>/dev/null || true)
if [ "$seen" = "$workspace/service" ]; then
  echo "ok: the hired agent works in $seen"
else
  echo "fail: expected the hired agent in $workspace/service, it worked in '${seen:-nowhere}'" >&2
  exit 1
fi
case "$answer" in
  *smoke-post*) echo "ok: the hired agent's post reached the board" ;;
  *)
    echo "fail: the board did not show the hired agent's post: $answer" >&2
    exit 1
    ;;
esac
