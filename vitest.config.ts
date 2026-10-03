import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Rendering tests explicitly simulate a color terminal and override these
  // values for NO_COLOR/non-TTY cases. Do not inherit the launcher environment.
  test: { include: ['tests/**/*.test.ts'], maxWorkers: 4, env: { NO_COLOR: '', FORCE_COLOR: '1' } },
});
