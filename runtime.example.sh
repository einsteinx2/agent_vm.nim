#!/bin/bash
# =============================================================================
# runtime.example.sh — Template for ~/.agent-vm/runtime.sh
# =============================================================================
#
# This file runs inside every agent-vm on each start, before the per-project
# .agent-vm.runtime.sh script. Copy it to ~/.agent-vm/runtime.sh and uncomment
# the sections you need.
#
# To get started:
#   cp runtime.example.sh ~/.agent-vm/runtime.sh
#   # Edit the file with your own values
#   chmod +x ~/.agent-vm/runtime.sh
#
# Note: if you run `npm install` (or other installs that produce arch-specific
# binaries) here or in a project's .agent-vm.runtime.sh, the result is written
# into the shared host directory and can clash with the host's own install. To
# give the VM its own independent copy, list the directory in a project's
# .agent-vm.shadow file. See .agent-vm.shadow.example.


# =============================================================================
# 1. SSH authentication for GitHub
# =============================================================================
#
# Embed your SSH private key (base64-encoded) so the VM can push/pull over SSH.
#
#   To encode your key:
#     cat ~/.ssh/id_ed25519 | base64
#
#   Paste the output below:

# SSH_KEY_B64="<your-base64-encoded-private-key>"
# mkdir -p ~/.ssh && chmod 700 ~/.ssh
# echo "$SSH_KEY_B64" | base64 -d > ~/.ssh/id_ed25519
# chmod 600 ~/.ssh/id_ed25519
# ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null


# =============================================================================
# 2. Git configuration
# =============================================================================

# git config --global user.name "Your Name"
# git config --global user.email "you@example.com"

# Force SSH for all GitHub remotes (avoids HTTPS credential prompts)
# git config --global url."git@github.com:".insteadOf "https://github.com/"


# =============================================================================
# 3. GitHub CLI authentication
# =============================================================================
#
# Required for creating PRs, commenting on issues, etc. from inside the VM.
#
#   To create a token: https://github.com/settings/tokens
#   Scopes needed: repo, read:org
#
# echo "<your-github-pat>" | gh auth login --with-token


# =============================================================================
# 4. Claude Code authentication
# =============================================================================
#
# Skip interactive login by providing a long-lived OAuth token.
#
#   To generate a token (on your host machine, one-time):
#     claude setup-token
#
#   Copy the token and paste it below:

# echo 'export CLAUDE_CODE_OAUTH_TOKEN="<your-setup-token>"' >> ~/.zshenv
#
# Skip the first-run onboarding flow so Claude starts without interactive setup:
# CLAUDE_JSON="$HOME/.claude.json"
# jq '.hasCompletedOnboarding = true | .lastOnboardingVersion = "0.0.0"' "$CLAUDE_JSON" > "$CLAUDE_JSON.tmp" && mv "$CLAUDE_JSON.tmp" "$CLAUDE_JSON"

# Enable dangerously-skip-permissions mode (only safe inside a sandbox/VM).
# Add "defaultMode": "bypassPermissions" to your ~/.claude/settings.json.


# =============================================================================
# 5. Claude Code skills
# =============================================================================
#
# Clone shared skills into the global skills directory.
# These will be available in all projects.

# mkdir -p ~/.claude/skills
# git clone git@github.com:your-org/claude-skills.git ~/.claude/skills/your-org-skills

# You can also install skills into the current project's directory.
# These will only be available when working in that project.

# PROJECT_DIR="$(pwd)"
# mkdir -p "$PROJECT_DIR/.claude/skills"
# git clone git@github.com:your-org/project-skills.git "$PROJECT_DIR/.claude/skills/project-skills"


# =============================================================================
# 6. MCP servers
# =============================================================================
#
# Add MCP servers available to Claude Code in all projects (--scope user).
#
# claude mcp add --scope user my-mcp-server npx -y my-mcp-server@latest


# =============================================================================
# 7. Claude Code status line
# =============================================================================
#
# Install a custom status line command in ~/.claude/settings.json.
# The command output is displayed at the bottom of the Claude Code interface.
#
# For example, to show the current git branch:
#
# cat > /tmp/statusline-patch.json << 'PATCH'
# {"statusLine": {"command": "git branch --show-current 2>/dev/null || echo ''"}}
# PATCH
#
# if [ -f ~/.claude/settings.json ]; then
#   jq -s '.[0] * .[1]' ~/.claude/settings.json /tmp/statusline-patch.json > /tmp/settings-merged.json
#   mv /tmp/settings-merged.json ~/.claude/settings.json
# else
#   mkdir -p ~/.claude
#   cp /tmp/statusline-patch.json ~/.claude/settings.json
# fi
# rm -f /tmp/statusline-patch.json
