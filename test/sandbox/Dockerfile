# Throwaway container for the agent edge-case suite. Several of those tests exist to prove that a
# scheduled `rm` or an unapproved command does *not* run, so they must never run on a real machine.
FROM node:24-slim

# Pin the same pnpm the repo is developed with: a newer one resolves the committed lockfile under a
# different policy and refuses to install it.
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /repo

# Dependencies first, so editing sources does not re-download them.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# The suite refuses to start unless it can see it is in the sandbox.
ENV ALTERAN_SANDBOX=1

CMD ["pnpm", "vitest", "run", "--config", "vitest.sandbox.config.ts"]
